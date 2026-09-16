# Phase 8: 店舗管理者（ダッシュボード / 店舗編集 / メニュー / レビュー返信）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 店舗オーナーが自分の店だけを、閲覧・編集・公開・分析できる管理アプリを完成させる。設計書 §5.1 の `(owner)/` 18 画面のうち Phase 7 担当の予約 2 画面を除く 16 画面と、それを支える API 32 本を実装する。

**Architecture:** 所有権は「アプリ層の `if`」ではなく「SQL の `WHERE owner_id = ?`」で表現する。API は `/owner/**` という独立した名前空間に置き、`roleGuard('owner')` を名前空間に 1 回だけ適用する。これにより「役割で弾く（403）」と「所有権で弾く（404）」が物理的に別レイヤーになり、権限マトリクスが「匿名 401 / user 403 / admin 403 / owner は自店 2xx・他店 404」という 1 行のルールに畳まれる。画像は Worker 経由（R2 バインディング `MEDIA`）でアップロードし、バイト列が着地するのと同じリクエストで所有権・サイズ・実際のファイル形式を検証する。モバイルは既存の `components/ui/` プリミティブ 8 種を組み替えて画面を作り、グラフは既存依存の `react-native-svg` で自作する。

**Tech Stack:** Hono 4.13.7 / Drizzle ORM 0.45.2 / Cloudflare D1 + R2（`@cloudflare/workers-types` 5.20260915.1） / Better Auth 1.7.5 / Zod 4.6.5 / Vitest 5.0.0 / miniflare 5.20260911.1-alpha / Stryker 10.0.0 ／ Expo SDK 57.0.22 / React Native 0.86.3 / React 19.2.3 / expo-router 57.0.21 / NativeWind 4.2.7 / TanStack Query 5.102.8 / react-hook-form 7.88.0 + @hookform/resolvers 5.9.1 / react-native-maps 1.27.2 / react-native-svg 15.15.4 / expo-image-picker 57.0.17 / Jest 30.5.1 + jest-expo 57.0.5 + @testing-library/react-native 14.0.1 / TypeScript 6.0.3 / Node 22.23.2

---

## Global Constraints

すべてのタスクの要件に、以下が暗黙に含まれる。

### 命名（`docs/CODING_GUIDELINES.md` §1 より）

| 対象                         | 規則                                     | 例                                                        |
| ---------------------------- | ---------------------------------------- | --------------------------------------------------------- |
| ファイル・ディレクトリ       | kebab-case（例外なし）                   | `owner-photo-repository.ts`, `shop/menu/[menuItemId].tsx` |
| React コンポーネント         | PascalCase                               | `KpiCard`, `MenuItemRow`                                  |
| 関数・変数                   | camelCase                                | `findOwnedShopId`, `unansweredCount`                      |
| 定数                         | UPPER_SNAKE_CASE                         | `UPLOAD_MAX_BYTES`, `STATS_RANGE_DAYS`                    |
| 型・インターフェース         | PascalCase（`I` 接頭辞なし）             | `OwnerShopSummary`, `StatsRangeDays`                      |
| Zod スキーマ                 | `<名前>Schema`                           | `menuItemCreateSchema`                                    |
| カスタムフック               | `use` + camelCase                        | `useOwnerShop`, `useShopStats`                            |
| Zustand ストア               | `use<名前>Store`                         | 本フェーズでは新規追加なし                                |
| DB テーブル・カラム          | snake_case                               | `shop_daily_stats`, `discount_type`                       |
| R2 オブジェクトキー          | `<種別>/<id>/<uuid>.<ext>`               | `shop-photos/shp_001/3f2a....webp`                        |
| 真偽値                       | `is` / `has` / `can` / `should` で始める | `isCover`, `hasReply`, `canPublish`                       |
| 数値                         | 単位を名前に入れる                       | `slotMinutes`, `priceYen`, `UPLOAD_MAX_BYTES`             |
| expo-router の動的セグメント | 具体名                                   | `[menuItemId]`, `[campaignId]`, `[reviewId]`              |

### 禁止（`docs/CODING_GUIDELINES.md` §2 より）

- `any` 禁止。`unknown` + 型ガード、外部データは Zod で parse する。
- `as` による型アサーション禁止。ブランド型の生成点（`toShopId` 等）のみ例外。
- `console.log` 禁止。
- マジックナンバー / マジックストリング禁止。`constants/` か `src/db/constants.ts` に定義する。
- 未使用の import / 変数禁止（`noUnusedLocals` / `noUnusedParameters` が有効）。
- 根拠のない `// TODO` 禁止。
- `!`（non-null アサーション）禁止。`noUncheckedIndexedAccess` が有効なので、配列アクセスは必ず `undefined` 分岐を書く。
- デフォルトエクスポート禁止。**例外は expo-router の画面ファイルのみ**（`app/**` 直下の `.tsx`）。
- 新しい npm パッケージの追加禁止（本フェーズは既存依存だけで完結する。§「設計判断 4」参照）。

### TypeScript

`exactOptionalPropertyTypes` / `verbatimModuleSyntax` / `noUncheckedIndexedAccess` / `noUnusedLocals` / `noUnusedParameters` が有効。したがって：

- 省略可能プロパティは `field?: T | undefined` と書く（`field?: T` だけだと `undefined` を明示代入できない）。
- 型だけの import は `import type { X } from '...'` と書く。

### テスト

- TDD。テストを書く → **実行して失敗を確認する** → 最小実装 → 通す → コミット。失敗確認を飛ばさない（規約 §6.1）。
- テスト名は日本語で振る舞いを書く（規約 §6.2）。
- 境界値を必ず書く（規約 §6.3）。
- バグ修正は再現テストから（規約 §6.4）。
- `apps/mobile` の Jest は `coverageThreshold.global` が statements / branches / functions / lines すべて 100%。新規ファイルは全分岐を通すテストが要る。
- `apps/api` / `packages/core` / `packages/geo` は Stryker のミューテーションスコアしきい値 `{ high: 95, low: 85, break: 85 }`。`--no-file-parallelism` 必須。

### 生き残った変異（survived mutant）への対応は 3 つだけ

1. **テストの穴** → テストを足して殺す。
2. **出力を変えない最適化**（キャッシュ・早期 return など） → 呼び出し回数やクエリ発行回数を検証して縛る。
3. **到達不能なコード** → 到達できる形に書き直してから殺す。

**「Stryker の設定で除外する」は選択肢にない。** `stryker.base.mjs` のコメントが明示するとおり、除外が許されるのは「サンドボックス外（`docs/`）を読むテスト」だけで、既存の唯一の例外は `design-doc-sync.test.ts` である。本フェーズで新しい除外を追加してはならない。

### API のエラー応答

Phase 4 で確立した形式を変えない。

```json
{ "error": { "status": 404, "message": "対象が見つかりません" } }
```

- 401 = 未認証。
- 403 = **役割だけで拒否**（リソース ID を読む前に判断できる場合）。
- 404 = **所有権・可視性で拒否**（ID の存在を漏らさないため）。
- メッセージは固定文言のみ。スタックトレース・SQL 文・内部 ID を本文に入れない。

### コメント

日本語で、「何をしているか」ではなく「**なぜそうしているか**」を書く（規約 §5）。非自明な定数には根拠を添える。

---

## 前提：このフェーズが立っている足場

**重要（正直な前提）：** 本計画を書いた時点で、リポジトリに実装済みなのは **Phase 0〜3 と Phase 5 の Task 5-1 まで**である（`git log` で確認）。Phase 4 / 5 / 6 / 7 は計画書としては存在するが、コードはまだ無い。したがって本計画の「Consumes」に並ぶ Phase 4〜7 の関数シグネチャは、**それらの計画書に書かれた契約を読み取ったもので、実測値ではない**。Phase 8 の実装を始める時点で Phase 4〜7 が完了していれば、最初のタスク（8-1）の冒頭で実際のシグネチャと突き合わせること。ズレていたら Phase 8 側を実物に合わせる。

### 実測で確認済みの足場（このリポジトリを実際に開いて確認した）

| 事実                                                                                                                                                     | 確認場所                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| R2 バケット `MEDIA`（`meshimap-media`）が設定済み                                                                                                        | `apps/api/wrangler.jsonc` の `r2_buckets`                                             |
| `preview_bucket_name` は**未設定**                                                                                                                       | 同上                                                                                  |
| `R2Bucket` 型に署名 URL 生成 API は**存在しない**（`head` / `get` / `put` / `createMultipartUpload` / `resumeMultipartUpload` / `delete` / `list` のみ） | `node_modules/@cloudflare/workers-types/index.d.ts:2486-2516`（version 5.20260915.1） |
| `shop_photos.r2_key` は `consistsOf(r2Key, 'a-z0-9/._-')` の CHECK を持つ                                                                                | `apps/api/src/db/schema/shop-detail.ts:142`                                           |
| `menu_items.r2_key` / `review_photos.r2_key` も同じ CHECK                                                                                                | `apps/api/src/db/schema/menu.ts:126`, `review.ts:116`                                 |
| `IDENTIFIER_PATTERN` は `/^[A-Za-z0-9_-]+$/` で**大文字を許す**                                                                                          | `packages/core/src/identifier.ts:17`                                                  |
| `shops.geohash` は `lengthIs(geohash, 7)` と `consistsOf(geohash, '0-9bcdefghjkmnpqrstuvwxyz')` の CHECK を持つ                                          | `apps/api/src/db/schema/shop.ts`                                                      |
| 索引 `idx_shops_status_geohash` が存在する                                                                                                               | 同上                                                                                  |
| `shop_photos` に部分ユニーク索引 `uq_shop_photos_cover`（`WHERE is_cover`）がある                                                                        | `apps/api/src/db/schema/shop-detail.ts`                                               |
| `menu_items` は `(shop_id, category_id) → menu_categories(shop_id, id)` の複合 FK を持つ                                                                 | `apps/api/src/db/schema/menu.ts`                                                      |
| `review_replies` は `review_id` が PK で、`(review_id, shop_id) → reviews(id, shop_id)` の複合 FK を持つ                                                 | `apps/api/src/db/schema/review.ts`                                                    |
| `shop_applications.documents` は `ApplicationDocument[]` の JSON 列、既定値 `[]`                                                                         | `apps/api/src/db/schema/admin.ts`                                                     |
| `APPLICATION_STATUSES` に `'returned'` が含まれる                                                                                                        | `apps/api/src/db/constants.ts`                                                        |
| `apps/mobile/package.json` にチャートライブラリは**無い**。`react-native-svg@15.15.4` はある                                                             | `apps/mobile/package.json`                                                            |
| `drizzle-orm/d1` の DB は `batch()` を持つ                                                                                                               | `node_modules/drizzle-orm/d1/driver.d.ts:9`                                           |
| マイグレーションは `0000_init.sql` / `0001_shops_fts.sql` まで。journal は `"version": "7"`、各エントリは `"version": "6"`                               | `apps/api/migrations/meta/_journal.json`                                              |
| `packages/core` は `shopCreateSchema` / `shopUpdateSchema` などを barrel から export し、`index.test.ts` が export 一覧を完全一致で固定している          | `packages/core/src/index.ts`, `index.test.ts`                                         |
| `design-doc-sync.test.ts` が設計書 §6 のテーブル名と `schema/index.ts` の export を完全一致で突合する                                                    | `apps/api/src/db/schema/design-doc-sync.test.ts`                                      |
| `apps/mobile/src/components/ui/` に 8 プリミティブ（Badge / Button / Card / EmptyState / ErrorState / Icon / Input / Skeleton）                          | `apps/mobile/src/components/ui/`                                                      |

### 命名の食い違いを 1 つ解消する

Phase 4 の引き継ぎ文書は `AppBindings` に `PHOTOS: R2Bucket` を足すと書いているが、`wrangler.jsonc` の実際のバインディング名は `MEDIA` である。**`MEDIA` を採用する。** バインディング名は `wrangler.jsonc` が正であり、型定義側を実物に合わせる。写真以外（申請書類）も同じバケットに入るので、意味的にも `MEDIA` の方が正しい。

---

## 設計判断

### 判断 1：所有権の境界をどこに置くか

**結論：SQL の `WHERE owner_id = ?` に置く。アプリ層の `if (shop.ownerId !== actor.userId)` は書かない。**

理由は 3 つある。

1. **「他人の店」と「存在しない店」が同じ結果に収束する。** `SELECT id FROM shops WHERE id = ? AND owner_id = ?` は、どちらの場合も 0 行を返す。呼び出し側は `null` を受け取り、一律 404 を返す。ID の存在有無が応答から漏れない。アプリ層で `if` を書くと、まず「行を取れた」という事実が生まれ、そこから 403 と 404 を分けたくなる誘惑が発生する。SQL に埋めれば、その分岐が構文上つくれない。
2. **UPDATE / DELETE でも同じ形が使える。** `UPDATE shops SET ... WHERE id = ? AND owner_id = ?` は、他人の店なら 0 行更新で終わる。「読んでから確認して書く」という TOCTOU の窓が無い。D1 は対話型トランザクションを持たないので、これは安全性の要件でもある。
3. **子テーブルにも素直に伝播する。** メニュー・写真・営業時間は `shop_id` を持つので、`WHERE id = ? AND shop_id = ?` に所有済み `shopId` を渡せば、それだけで境界になる。

具体的には `apps/api/src/repositories/owner-scope.ts` に 3 つの関数を置く。

```ts
export async function findOwnedShopId(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
): Promise<ShopId | null>;
export async function findOwnedReviewShopId(
  db: Database,
  actor: OwnerActor,
  reviewId: ReviewId,
): Promise<ShopId | null>;
export async function findOwnedCampaignShopId(
  db: Database,
  actor: OwnerActor,
  campaignId: string,
): Promise<ShopId | null>;
export async function findOwnedShopLocation(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
): Promise<{ readonly lat: number; readonly lng: number } | null>;
```

後ろ 2 つは `reviews` / `campaigns` から `shops` へ JOIN し、`shops.owner_id = ?` で絞る。レビュー返信とクーポン編集は URL に `shopId` を含まないので、ID からオーナーへ遡る経路がここに 1 本だけ要る。

**役割の拒否（403）は別レイヤーに置く。** `/owner/**` を Hono のサブアプリにし、`roleGuard(ROLE_OWNER)` をそこに 1 回だけ掛ける。これで匿名は 401、`user` と `admin` は 403 になる。リソース ID を読む前に判定が終わるので、403 と 404 の使い分け規則（Phase 4）に自動的に従う。

**admin を 403 にする理由：** admin にオーナー API を通すと、リポジトリの引数が `OwnerActor | AdminActor` のユニオンになる。Phase 4 の Task 4-2 はこのユニオンを明確に拒否していた（ブランド型の意味が消えるため）。admin による店舗操作は Phase 9 の `(admin)/shops/[shopId].tsx` と `/admin/**` が担当する。

**証明のしかた（Task 8-4）：** オーナー A とオーナー B、A の店 1 件を用意し、B の `OwnerActor` で A の店に対する全書き込み系リポジトリ関数を呼び、(a) 戻り値が `null` / `false` であること、(b) **DB の当該行が 1 バイトも変わっていないこと**を両方検証する。(b) が本質で、戻り値だけ見ていると「書いてから null を返す」実装を見逃す。

### 判断 2：画像アップロードは署名付き URL か、Worker 経由か

**結論：Worker 経由（pass-through）。`MEDIA` バインディングに `put` する。**

1. **署名 URL は現実的に作れない。** `@cloudflare/workers-types@5.20260915.1` の `R2Bucket`（`index.d.ts:2486-2516`）には署名 URL を作るメソッドが無い。実現するには S3 互換エンドポイント用のアクセスキーを発行し、Worker 内で SigV4 署名を自前実装（または `aws4fetch` 等を追加）することになる。本フェーズは新規依存を入れない方針であり、自前 SigV4 は「署名がバグっていても静かに通る」種類のコードで、ポートフォリオの主題（所有権の境界）と関係の無いリスクを増やす。
2. **Worker 経由なら、所有権・サイズ・形式の検証がバイト列と同じリクエストに乗る。** 署名 URL 方式だと「URL を発行した時点では正当だったが、クライアントが別の内容を PUT する」窓が開き、R2 のイベント通知や後追いバリデーションが必要になる。Worker 経由なら `findOwnedShopId` → バイト列検証 → `MEDIA.put` → `shop_photos` INSERT が 1 本の流れになる。
3. **コストは画像 1 枚 5MB 以下という上限で抑える。** 店舗写真は表示用なので 5MB で十分。Workers のリクエストボディ上限（プランにより 100MB / 500MB と公表されているが、**このリポジトリからは検証できないので未確認**）よりずっと小さい側で運用する。

**検証はクライアントと Worker の両方でやる。役割が違う。**

| 場所     | 何を見るか                                              | 目的                                                                                 |
| -------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| モバイル | `ImagePickerAsset.fileSize` / `asset.mimeType`          | 5MB 超や非対応形式を、アップロード前に即座に文言で返す（UX）。ネットワークを使わない |
| Worker   | `Content-Length` と**実バイト列の先頭マジックナンバー** | 権威ある判定。クライアントの `Content-Type` は偽装できるので信用しない               |

Worker 側のマジックナンバー判定（`detectImageType`）：

- JPEG: `FF D8 FF`
- PNG: `89 50 4E 47 0D 0A 1A 0A`
- WebP: 先頭 `52 49 46 46`（`RIFF`）かつ 8..11 バイト目が `57 45 42 50`（`WEBP`）
- PDF: `25 50 44 46 2D`（`%PDF-`、申請書類のみ許可）

**R2 キーの落とし穴（実測で発見）：** `shop_photos.r2_key` には `consistsOf(r2_key, 'a-z0-9/._-')` の CHECK があるのに、`IDENTIFIER_PATTERN` は大文字を許す（`/^[A-Za-z0-9_-]+$/`）。大文字を含む `shopId` をそのままキーに埋めると、R2 への `put` は成功したのに D1 の INSERT が CHECK 違反で落ちる、という「孤児オブジェクト」が生まれる。よって `buildShopPhotoKey` は**キーを組み立てた直後に自前で同じ文字集合を検証し、違反なら例外を投げる**（R2 に書く前に落とす）。Task 8-6 のテストでこの境界を明示的に突く。

**R2 の前提整備（Task 8-2）：**

- **`AppBindings` の `MEDIA: R2Bucket` は追加不要。** `apps/api/src/lib/app-env.ts` を開いて確認したところ、Phase 4 が既に `readonly MEDIA: R2Bucket;` を書いている（`wrangler.jsonc` の `r2_buckets` と同名）。Task 8-2 では「既にあること」を確認するだけで、型定義には手を入れない。
- `apps/api/src/db/testing/local-d1.ts` の miniflare オプションに `r2Buckets: { MEDIA: 'meshimap-media-test' }` を追加し、テストから実物の R2 API を叩けるようにする。
- `preview_bucket_name` は**追加しない**。これは `wrangler dev --remote` で本番バケットを汚さないための設定だが、本プロジェクトの開発は `wrangler dev`（ローカル、miniflare の擬似 R2）とテストで完結しており、追加しても検証できない設定が増えるだけになる。
- **未確認：** 本番 Cloudflare 上での R2 の挙動は、このリポジトリからは検証できない。テストで担保できるのは miniflare の R2 実装までである。

### 判断 3：地図ピンのドラッグで緯度経度を確定し、geohash をどこで振り直すか

**結論：アプリ層（リポジトリ）で `@meshimap/geo` を使って振り直す。DB トリガーは使わない。**

1. **SQLite のトリガーから `@meshimap/geo` は呼べない。** D1 はユーザー定義関数の登録に対応していないので、トリガーで geohash を作るなら base32 エンコードを SQL の文字列関数で書き直すことになる。同じアルゴリズムの実装が 2 つになり、片方は `packages/geo` のテスト（およびミューテーションテスト）の保護下に無い。これは最悪の形の重複である。
2. **`shops.geohash` の CHECK が最後の防波堤として残る。** `ck_shops_geohash_length`（長さ 7）と `ck_shops_geohash_alphabet`（`0-9bcdefghjkmnpqrstuvwxyz`）があるので、アプリ層が壊れた値を書こうとすれば INSERT / UPDATE が落ちる。「トリガーで整合性を守る」代わりに「CHECK で不整合を拒否する」という、D1 で実際に機能する形になっている。
3. **緯度経度と geohash を同じ UPDATE 文に入れる。** `UPDATE shops SET lat = ?, lng = ?, geohash = ?, updated_at = ? WHERE id = ? AND owner_id = ?` と 1 文で書けば、両者がズレた中間状態が存在しない。`idx_shops_status_geohash` は UPDATE と同時に自動で追随する。

モバイル側は `react-native-maps` の `Marker` に `draggable` と `onDragEnd` を付ける。`onDragEnd` の `event.nativeEvent.coordinate` から `{ latitude, longitude }` を取り、`latitudeSchema` / `longitudeSchema`（`packages/core`）で parse してからフォーム状態に入れる。地図が返す値であっても、外から来た値は parse する（規約 §4.3）。

Phase 4 の `updateShopAsOwner` は既に `coordinate()` と `encodeGeohash()` を消費する契約になっているので、`PATCH /shops/:shopId` が基本情報と位置の両方を担う。Phase 8 が足すのは**「ピンを動かしたら geohash が実際に書き換わる」という回帰テスト**である（Task 8-4）。緯度経度だけ更新して geohash を更新し忘れる、という退行はこのテストでしか捕まらない。

### 判断 4：KPI グラフに新しいライブラリを入れるか

**結論：入れない。`react-native-svg@15.15.4` で折れ線を自作する。**

1. **既に依存にある。** `apps/mobile/package.json` を開いて確認した。チャートライブラリは 1 つも無く、`react-native-svg` は 15.15.4 で入っている。設計書 §5.2 も「`react-native-svg` で自作した折れ線グラフ」と明記している。
2. **100% カバレッジしきい値との相性。** `apps/mobile/jest.config.js` の `coverageThreshold.global` は 4 指標すべて 100%。サードパーティのチャートコンポーネントをラップすると、そのライブラリが要求する props の組み合わせ分岐（データ 0 件、全部同じ値、負値など）を自分のラッパーで吸収することになり、テストで通せない分岐が増える。
3. **グラフの本質は純関数に落とせる。** 「日次の値の配列 → SVG の `d` 属性文字列」は純粋な写像で、`buildLinePath(values, width, height)` として切り出せる。純関数はミューテーションテストが最も効く形であり、境界（値が 1 個、全部同じ値で分母 0、値が空）をテストで固定できる。SVG の描画自体は `<Path d={...} />` 1 個で済む。

**未確認：** `react-native-svg` の `Svg` / `Path` が jest-expo 環境で追加のモック無しにレンダリングできるかは、実行して確かめていない。Task 8-15 の Step 2 でテストを実行したときに、もしネイティブモジュール関連のエラーが出たら、`jest.config.js` の `setupFiles` にモックを足す（`TRANSPILED_NODE_MODULES` は `react-native` を前方一致で含むので、変換対象には既に入っている）。

### 判断 5：フォーム検証の Zod スキーマをどこに置くか

**結論：`packages/core/src/schema.ts` に置いて API とモバイルで共有する。**

1. **既存の実践がそうなっている。** `packages/core/src/schema.ts` には `shopCreateSchema` / `shopUpdateSchema` / `reviewCreateSchema` / `reservationCreateSchema` / `businessHoursSchema` が既にあり、`packages/core/src/index.ts` の barrel から export されている。Phase 2 / 4 はこれを両側で使う前提で書かれている。
2. **本フェーズのフォームは両側で検証する。** メニュー・営業時間・座席・クーポンはいずれも「モバイルでフォーム検証」→「API で再検証」という二重チェックが要る。二重チェックが同じスキーマでないと、モバイルは通るが API が 422 を返す（あるいはその逆）という食い違いが起きる。共有すれば食い違いが構造的に起きない。
3. **例外は 1 つだけ。** 画像アップロードのバイト列検証はモバイルと Worker で見るものが違う（`ImagePickerAsset.fileSize` vs `ArrayBuffer` のマジックナンバー）ので、共有しない。共通なのは `UPLOAD_MAX_BYTES` と許可 MIME の定数のみで、これは `packages/core` の定数として共有する。

`packages/core/src/index.ts` と `index.test.ts` は export 一覧を完全一致で固定しているので、**スキーマを足すときは必ず両方を同時に編集する**（Task 8-3）。

### 判断 6（付随）：不足しているデータモデルをどう足すか

設計書 §6 のデータモデルには、Phase 8 が必要とする 2 つのテーブルが無い。

| 必要なもの                                                      | 現状                                                                        | 対処                                                                                  |
| --------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| クーポン（`campaigns/index.tsx`, `campaigns/[campaignId].tsx`） | テーブルが無い                                                              | `campaigns` を新設                                                                    |
| 日別の閲覧数（ダッシュボードの KPI 推移）                       | `shops.view_count` は累計のみ。しかも**どのフェーズもこれを加算していない** | `shop_daily_stats` を新設し、公開エンドポイント `POST /shops/:shopId/views` で UPSERT |

保存数 / 予約数 / 平均評価は `favorites.created_at` / `reservations.created_at` / `reviews.created_at` の `GROUP BY` で日別に出せるので、テーブルは要らない。閲覧数だけはイベントの記録先が無いので追加する。1 イベント 1 行にすると人気店で行が無制限に増えるため、`(shop_id, date)` を複合 PK にして `ON CONFLICT DO UPDATE SET view_count = view_count + 1` で潰す。

テーブルを足すと `design-doc-sync.test.ts` と `index.test.ts` の `DESIGN_DOC_TABLE_NAMES` が落ちる。**設計書 §6 のコードブロック・`schema/index.ts` の re-export・`index.test.ts` の配列の 3 つを同じコミットで更新する**（Task 8-1）。

### 判断 7（付随）：オンボーディングの 2 画面の担当範囲

`(owner)/onboarding/apply.tsx` と `status.tsx` は「**既にオーナーになっている人が、差し戻された申請を再提出する**」画面である。`user` から `owner` への初回申請（まだ `(owner)` グループに入れない人）はルートグループが違うので、Phase 8 では扱わない。

**2026-09-16 訂正。** ここは元々「初回申請は Phase 5 の担当」と書いていたが、**Phase 5 は Task 5-19 で初回申請をスコープ外にした**ため、担当フェーズが一時的に不在になっていた。**初回申請は Phase 9 が引き取った**（Phase 9 計画書の「追補: 初回店舗申請（`user` → `owner`）を Phase 9 が引き取る」節、Task 9-25 / 9-26 / 9-27）。Phase 9 は `POST /shop-applications` などの 4 本と `(user)/settings/shop-application.tsx` を実装し、承認は既存の Task 9-5 が受ける。**Phase 8 の 3 本（`/owner/application*`）とは経路が別で、重複しない。**

Phase 5 の `ShopApplicationStatus` は `'pending' | 'approved' | 'rejected'` の 3 値だが、DB の `APPLICATION_STATUSES` は `'returned'` を含む 4 値である。`status.tsx` の「差し戻し理由を表示して再提出させる」要件は `'returned'` が無いと成立しないので、**Phase 8 でモバイル側の型を 4 値に広げる**（Task 8-15 の `shopApplicationSchema` で 4 値にする）。

---

## 他フェーズから受け取るもの（Consumes の一覧）

**すべて計画書から読み取った契約であり、実測値ではない。** 実装開始時に実物と突き合わせること。

| 出所                  | 名前                                                                                                                                                                                                                                                                                | シグネチャ / 形                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/core`       | `ShopId`, `UserId`, `ReviewId`                                                                                                                                                                                                                                                      | ブランド型                                                                                             |
| `packages/core`       | `toShopId`, `toUserId`, `toReviewId`                                                                                                                                                                                                                                                | `(value: string) => XxxId`（不正値で `RangeError`）                                                    |
| `packages/core`       | `IDENTIFIER_MAX_LENGTH`                                                                                                                                                                                                                                                             | `64`                                                                                                   |
| `packages/core`       | `JstDate`, `toJstDate`, `toJstClock`, `addJstDays`                                                                                                                                                                                                                                  | `toJstClock(now: Date) => { date: JstDate; dayOfWeek: DayOfWeek; minuteOfDay: MinuteOfDay }`           |
| `packages/core`       | `latitudeSchema`, `longitudeSchema`, `identifierSchema`, `minuteOfDaySchema`, `dayOfWeekSchema`, `budgetYenSchema`                                                                                                                                                                  | Zod スキーマ                                                                                           |
| `packages/core`       | `businessHoursSchema`, `shopUpdateSchema`                                                                                                                                                                                                                                           | Zod スキーマ                                                                                           |
| `packages/geo`        | `coordinate(lat, lng)`, `encodeGeohash(coord, precision)`                                                                                                                                                                                                                           | Phase 1                                                                                                |
| `apps/api` Phase 3    | `createMigratedD1()`, `LocalD1`                                                                                                                                                                                                                                                     | `apps/api/src/db/testing/local-d1.ts`                                                                  |
| `apps/api` Phase 3    | `SHOP_GEOHASH_PRECISION`(7), `SHOP_STATUSES`, `APPLICATION_STATUSES`, `REPORT_TARGET_TYPES`, `NOTIFICATION_TYPES`, `PRICE_YEN_MIN/MAX`, `SORT_ORDER_MIN`, `SEAT_CAPACITY_MIN/MAX`, `SLOT_MINUTES_MIN/MAX`, `MAX_PARALLEL_MIN/MAX`, `R2_KEY_MAX_LENGTH`, `R2_KEY_ALLOWED_CHARACTERS` | `apps/api/src/db/constants.ts`                                                                         |
| `apps/api` Phase 3    | `inValues`, `betweenInclusive`, `lengthAtMost`, `lengthIs`, `atLeast`, `matchesGlob`, `consistsOf`                                                                                                                                                                                  | `apps/api/src/db/sql-helpers.ts`                                                                       |
| `apps/api` Phase 4    | `OwnerActor`（認証ミドルウェア内でのみ生成可能）                                                                                                                                                                                                                                    | `{ readonly kind: 'owner'; readonly userId: UserId }` 相当                                             |
| `apps/api` Phase 4    | `roleGuard(role)`                                                                                                                                                                                                                                                                   | Hono ミドルウェア。役割不一致で 403                                                                    |
| `apps/api` Phase 4    | `AppBindings`                                                                                                                                                                                                                                                                       | `{ DB: D1Database; CACHE: KVNamespace; RESERVATION_LOCK: DurableObjectNamespace; ... }`                |
| `apps/api` Phase 4    | `Database`（Drizzle の型）                                                                                                                                                                                                                                                          | `DrizzleD1Database<typeof schema>` 相当                                                                |
| `apps/api` Phase 4    | `updateShopAsOwner(db, actor, shopId, input)`                                                                                                                                                                                                                                       | 基本情報 + 緯度経度 + geohash を 1 文で更新                                                            |
| `apps/api` Phase 4    | `ENDPOINT_CASES`（権限マトリクステスト）, `EXPECTED_ROUTE_PATTERNS`（突合テスト）                                                                                                                                                                                                   | Task 4-12 / 4-14                                                                                       |
| `apps/api` Phase 4    | `jsonError(c, status, message)` 相当のエラー応答ヘルパ                                                                                                                                                                                                                              | 固定文言                                                                                               |
| `apps/mobile` Phase 5 | `ROLE_HOME_ROUTES`, `OWNER_ONBOARDING_STATUS_ROUTE`, `PROFILE_QUERY_KEY`                                                                                                                                                                                                            | `apps/mobile/src/constants/auth.ts`（**実装済み**）                                                    |
| `apps/mobile` Phase 5 | `(owner)/(tabs)/_layout.tsx`（2 タブ）                                                                                                                                                                                                                                              | Phase 8 で 5 タブへ拡張                                                                                |
| `apps/mobile` Phase 5 | `ShopApplicationStatus`（3 値）                                                                                                                                                                                                                                                     | Phase 8 で 4 値へ拡張（Task 8-15）                                                                     |
| `apps/mobile` Phase 5 | 認証済み `fetch` ラッパ（Cookie を載せる）                                                                                                                                                                                                                                          | `features/auth/api.ts`                                                                                 |
| `apps/mobile` Phase 2 | `Badge`, `Button`, `Card`, `EmptyState`, `ErrorState`, `Icon`, `Input`, `Skeleton`                                                                                                                                                                                                  | `apps/mobile/src/components/ui/`（**実装済み**）                                                       |
| `apps/mobile` Phase 7 | `(owner)/(tabs)/reservations.tsx`, `(owner)/reservations/[reservationId].tsx`                                                                                                                                                                                                       | **Phase 8 では作らない・触らない。** ダッシュボードと店舗ハブからの遷移先として `router.push` するだけ |

---

## ファイル構成

### API（`apps/api/`）

| ファイル                                           | 責務                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/db/schema/campaign.ts`                        | **新規** `campaigns` テーブル定義                                                   |
| `src/db/schema/stats.ts`                           | **新規** `shop_daily_stats` テーブル定義                                            |
| `src/db/schema/index.ts`                           | 変更：上記 2 つを re-export                                                         |
| `src/db/constants.ts`                              | 変更：`CAMPAIGN_STATUSES` / `DISCOUNT_TYPES` / 各種長さ上限を追加                   |
| `migrations/0002_campaigns_and_daily_stats.sql`    | **新規** 上記 2 テーブルの DDL                                                      |
| `src/lib/media.ts`                                 | **新規** マジックナンバー判定・R2 キー生成と検証・`put` / `delete` のラッパ         |
| `src/lib/stats-range.ts`                           | **新規** 期間から JST 日付キー配列を作る純関数群                                    |
| `src/repositories/owner-scope.ts`                  | **新規** 所有権を SQL で解決する 3 関数                                             |
| `src/repositories/owner-hours-repository.ts`       | **新規** 営業時間・臨時休業                                                         |
| `src/repositories/owner-photo-repository.ts`       | **新規** 店舗写真（追加・並べ替え・カバー・削除）                                   |
| `src/repositories/owner-menu-repository.ts`        | **新規** メニューカテゴリ・メニュー項目                                             |
| `src/repositories/owner-seat-repository.ts`        | **新規** 座席設定                                                                   |
| `src/repositories/owner-review-repository.ts`      | **新規** レビュー一覧・返信・通報                                                   |
| `src/repositories/owner-campaign-repository.ts`    | **新規** クーポン                                                                   |
| `src/repositories/shop-stats-repository.ts`        | **新規** KPI 集計と閲覧記録                                                         |
| `src/repositories/owner-application-repository.ts` | **新規** 店舗申請の取得・書類追加・再提出                                           |
| `src/routes/owner/index.ts`                        | **新規** `/owner/**` サブアプリの組み立て（`requireOwner` を 1 回だけ適用）         |
| `src/routes/owner/guard.ts`                        | **新規** `OwnerEnv` 型・`requireOwner` ミドルウェア・共通ヘルパ                     |
| `src/routes/owner/shop-routes.ts`                  | **新規** 店舗一覧・KPI・位置・営業時間・臨時休業・座席（#14〜#20, #32, #33）        |
| `src/routes/owner/photo-routes.ts`                 | **新規** 写真（#21〜#25）                                                           |
| `src/routes/owner/menu-routes.ts`                  | **新規** メニュー（#26〜#31）                                                       |
| `src/routes/owner/review-routes.ts`                | **新規** レビュー・返信・通報（#34〜#37）                                           |
| `src/routes/owner/campaign-routes.ts`              | **新規** クーポン（#38〜#41）                                                       |
| `src/routes/owner/application-routes.ts`           | **新規** 申請の取得・書類追加・再提出（#42〜#44）                                   |
| `src/routes/shops.ts`                              | 変更：`POST /shops/:shopId/views` を追加（#45）                                     |
| `src/index.ts`                                     | 変更：`/owner` をマウント                                                           |
| `src/lib/app-env.ts`                               | **変更不要**（`AppBindings` に `MEDIA: R2Bucket` が既にある。実ファイルで確認済み） |
| `src/db/testing/local-d1.ts`                       | 変更：miniflare に `r2Buckets` を追加し、`LocalD1` に `mediaBucket` を生やす        |

### 共有（`packages/core/`）

| ファイル            | 責務                                                       |
| ------------------- | ---------------------------------------------------------- |
| `src/schema.ts`     | 変更：店舗管理系の入力スキーマを追加                       |
| `src/media.ts`      | **新規** アップロードの共有定数（上限バイト数・許可 MIME） |
| `src/index.ts`      | 変更：上記を barrel に追加                                 |
| `src/index.test.ts` | 変更：export 一覧の期待値を更新                            |

### モバイル（`apps/mobile/src/`）

| ファイル                                   | 責務                                                              |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `features/owner/api.ts`                    | **新規** `/owner/**` を叩く関数群。`fetch` を呼んでよい唯一の場所 |
| `features/owner/queries.ts`                | **新規** TanStack Query のフック群とクエリキー                    |
| `features/owner/types.ts`                  | **新規** API 応答の Zod スキーマと型                              |
| `components/chart/line-chart.tsx`          | **新規** SVG 折れ線（表示のみ）                                   |
| `components/chart/build-line-path.ts`      | **新規** 値配列 → SVG パス文字列の純関数                          |
| `components/owner/kpi-card.tsx`            | **新規** KPI 1 枚（現在値・前期間比・スパークライン）             |
| `components/owner/shop-section-link.tsx`   | **新規** 店舗ハブの行（アイコン・題・補足・未設定バッジ）         |
| `components/owner/menu-item-row.tsx`       | **新規** メニュー 1 行                                            |
| `components/owner/owner-review-card.tsx`   | **新規** レビュー + 返信状態                                      |
| `components/owner/photo-tile.tsx`          | **新規** 写真 1 枚（カバー印・並べ替えボタン）                    |
| `components/owner/campaign-row.tsx`        | **新規** クーポン 1 行                                            |
| `app/(owner)/(tabs)/_layout.tsx`           | 変更：2 タブ → 5 タブ                                             |
| `app/(owner)/(tabs)/dashboard.tsx`         | 変更：KPI 4 枚 + 折れ線 + 未対応セクション                        |
| `app/(owner)/(tabs)/shop.tsx`              | **新規** 店舗情報ハブ + 公開プレビュー導線                        |
| `app/(owner)/(tabs)/reviews.tsx`           | **新規** レビュー一覧（未返信バッジ）                             |
| `app/(owner)/(tabs)/account.tsx`           | 変更 or 新規：アカウント                                          |
| `app/(owner)/shop/basic.tsx`               | **新規** 基本情報                                                 |
| `app/(owner)/shop/hours.tsx`               | **新規** 営業時間・臨時休業                                       |
| `app/(owner)/shop/location.tsx`            | **新規** 地図ピンドラッグ                                         |
| `app/(owner)/shop/photos.tsx`              | **新規** 写真（追加・並べ替え・カバー）                           |
| `app/(owner)/shop/seats.tsx`               | **新規** 座席設定                                                 |
| `app/(owner)/shop/menu/index.tsx`          | **新規** メニュー一覧                                             |
| `app/(owner)/shop/menu/[menuItemId].tsx`   | **新規** メニュー編集（`new` で新規）                             |
| `app/(owner)/reviews/[reviewId]/reply.tsx` | **新規** 返信作成・編集                                           |
| `app/(owner)/campaigns/index.tsx`          | **新規** クーポン一覧                                             |
| `app/(owner)/campaigns/[campaignId].tsx`   | **新規** クーポン編集（`new` で新規）                             |
| `app/(owner)/onboarding/apply.tsx`         | **新規** 書類アップロード + 再提出                                |
| `app/(owner)/onboarding/status.tsx`        | **新規** 審査状況・差し戻し理由                                   |
| `constants/owner.ts`                       | **新規** 期間選択肢・KPI ラベル・上限値など                       |

### 設計書

| ファイル                                               | 責務                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `docs/superpowers/specs/2026-09-15-meshimap-design.md` | 変更：§6 のテーブル一覧に `campaigns` と `shop_daily_stats` を追記（`design-doc-sync.test.ts` が突合するため必須） |

---

## 権限マトリクス（Phase 8 で追加する 32 本）

Phase 4 の Task 4-12 の `ENDPOINT_CASES` にこの表の全行を追加し、Task 4-14 の `EXPECTED_ROUTE_PATTERNS` にルートパターンを追加する。**行を足さないと Task 4-14 の突合テストが落ちる**（Phase 4 の引き継ぎに明記されている）。

### Phase 8 は委譲しない（Phase 7 が導入した仕組みとの関係）

Phase 7 が `apps/api/src/routes/permission-matrix.test.ts` に 2 つの定数を足している。`DELEGATED_ROUTE_PATTERNS`（主体ごとの総当たりを別ファイルに委ねたルートの一覧）と `DELEGATABLE_PATH_PATTERN`（委譲を許すパスの形）である。**Phase 8 はこのどちらにも 1 行も足さない。** 理由は 2 つある。

1. **委譲先が無い。** Phase 8 の 32 本は `roleGuard(ROLE_OWNER)` 1 枚で権限が決まり、4 ロールぶんの期待値が `ENDPOINT_CASES` の 1 行に収まる。予約系（Phase 7 の `reservation-permission-matrix.test.ts`）や管理系（Phase 9 の `routes/admin/permission-matrix.test.ts`）のように専用の権限テストファイルを立てる必要が無い。**委譲先のファイルが無いものを委譲リストに入れてはならない。**
2. **正規表現に一致しない。** Phase 7 時点の `DELEGATABLE_PATH_PATTERN` は `/^\/(reservation-slots|reservations|owner\/reservations)(\/|$)/` である。Phase 8 が足すのは `/owner/shops/**` `/owner/reviews/**` `/owner/campaigns/**` `/owner/application*` `/shops/:shopId/views` で、**1 本もこの正規表現に一致しない**。`/owner/reservations`（Phase 7 の 4 本）とは兄弟のパスだが、`owner\/reservations` というリテラルには当たらない。

この 2 つの結果として、Phase 7 が足した it（「委譲しているのは予約系だけで、予約系は 1 本残らず委譲されている」）は **Phase 8 の後も 9 本 vs 9 本で緑のまま通る**。Phase 8 が `DELEGATABLE_PATH_PATTERN` に `owner` の 1 語を足してしまうと、この it は `/owner/**` の 35 本（Phase 7 の予約 4 本 + Phase 8 の 31 本）まで「委譲されているはず」と見なし、`40 本 vs 9 本` で即座に落ちる。**足さないこと。**

Phase 8 を終えた時点の 3 つの値は次のとおり。Phase 9 はこれを土台に `/admin/**` 32 本を**委譲側に**積み（Task 9-17 で 83 本 / 委譲 41 本）、さらに初回店舗申請の 4 本を**委譲せずに**積む（Task 9-26 で **87 本** / 委譲は 41 本のまま）。

| 定数                       | Phase 4 のみ | Phase 7 後   | **Phase 8 後（本計画書）** |
| -------------------------- | ------------ | ------------ | -------------------------- |
| `EXPECTED_ROUTE_PATTERNS`  | 10 本        | 19 本        | **51 本**（19 + 32）       |
| `DELEGATED_ROUTE_PATTERNS` | 無い         | 9 本（予約） | **9 本のまま**             |
| `DELEGATABLE_PATH_PATTERN` | 無い         | 予約系 3 語  | **同左（触らない）**       |

**Phase 8 が決めているのは増分 32 だけで、土台の本数ではない。** Phase 7 を飛ばして着手した場合は `EXPECTED_ROUTE_PATTERNS` が 10 本で、`DELEGATED_ROUTE_PATTERNS` と `DELEGATABLE_PATH_PATTERN` はまだ存在しない。そのときは 10 + 32 = 42 本になり、委譲の 2 定数は引き続き存在しないまま Phase 8 を終える（Phase 8 は導入しない）。着手前に実物を開いて本数を数え、「実物の本数 + 32」に読み替えること。

#14〜#44 は `/owner/**` 配下なので、匿名 = 401、`user` = 403、`admin` = 403 が**例外なく**成り立つ。`roleGuard(ROLE_OWNER)` をサブアプリに 1 回掛けた結果であり、各ハンドラには権限判定が 1 行も無い。

| #   | メソッド | ルートパターン                                     | 匿名 | user | admin | owner（自店） | owner（他店） |
| --- | -------- | -------------------------------------------------- | ---- | ---- | ----- | ------------- | ------------- |
| 14  | GET      | `/owner/shops`                                     | 401  | 403  | 403   | 200           | —             |
| 15  | GET      | `/owner/shops/:shopId/stats`                       | 401  | 403  | 403   | 200           | 404           |
| 16  | GET      | `/owner/shops/:shopId/location`                    | 401  | 403  | 403   | 200           | 404           |
| 17  | GET      | `/owner/shops/:shopId/hours`                       | 401  | 403  | 403   | 200           | 404           |
| 18  | PUT      | `/owner/shops/:shopId/hours`                       | 401  | 403  | 403   | 200           | 404           |
| 19  | POST     | `/owner/shops/:shopId/closures`                    | 401  | 403  | 403   | 201           | 404           |
| 20  | DELETE   | `/owner/shops/:shopId/closures/:closureId`         | 401  | 403  | 403   | 204           | 404           |
| 21  | GET      | `/owner/shops/:shopId/photos`                      | 401  | 403  | 403   | 200           | 404           |
| 22  | POST     | `/owner/shops/:shopId/photos`                      | 401  | 403  | 403   | 201           | 404           |
| 23  | PATCH    | `/owner/shops/:shopId/photos/:photoId`             | 401  | 403  | 403   | 200           | 404           |
| 24  | PUT      | `/owner/shops/:shopId/photo-order`                 | 401  | 403  | 403   | 200           | 404           |
| 25  | DELETE   | `/owner/shops/:shopId/photos/:photoId`             | 401  | 403  | 403   | 204           | 404           |
| 26  | GET      | `/owner/shops/:shopId/menu`                        | 401  | 403  | 403   | 200           | 404           |
| 27  | POST     | `/owner/shops/:shopId/menu/categories`             | 401  | 403  | 403   | 201           | 404           |
| 28  | DELETE   | `/owner/shops/:shopId/menu/categories/:categoryId` | 401  | 403  | 403   | 204           | 404           |
| 29  | POST     | `/owner/shops/:shopId/menu/items`                  | 401  | 403  | 403   | 201           | 404           |
| 30  | PATCH    | `/owner/shops/:shopId/menu/items/:menuItemId`      | 401  | 403  | 403   | 200           | 404           |
| 31  | DELETE   | `/owner/shops/:shopId/menu/items/:menuItemId`      | 401  | 403  | 403   | 204           | 404           |
| 32  | GET      | `/owner/shops/:shopId/seats`                       | 401  | 403  | 403   | 200           | 404           |
| 33  | PUT      | `/owner/shops/:shopId/seats`                       | 401  | 403  | 403   | 200           | 404           |
| 34  | GET      | `/owner/shops/:shopId/reviews`                     | 401  | 403  | 403   | 200           | 404           |
| 35  | PUT      | `/owner/reviews/:reviewId/reply`                   | 401  | 403  | 403   | 200           | 404           |
| 36  | DELETE   | `/owner/reviews/:reviewId/reply`                   | 401  | 403  | 403   | 204           | 404           |
| 37  | POST     | `/owner/reviews/:reviewId/report`                  | 401  | 403  | 403   | 201           | 404           |
| 38  | GET      | `/owner/shops/:shopId/campaigns`                   | 401  | 403  | 403   | 200           | 404           |
| 39  | POST     | `/owner/shops/:shopId/campaigns`                   | 401  | 403  | 403   | 201           | 404           |
| 40  | PATCH    | `/owner/campaigns/:campaignId`                     | 401  | 403  | 403   | 200           | 404           |
| 41  | DELETE   | `/owner/campaigns/:campaignId`                     | 401  | 403  | 403   | 204           | 404           |
| 42  | GET      | `/owner/application`                               | 401  | 403  | 403   | 200           | —             |
| 43  | POST     | `/owner/application/documents`                     | 401  | 403  | 403   | 201           | —             |
| 44  | POST     | `/owner/application/resubmit`                      | 401  | 403  | 403   | 200           | —             |
| 45  | POST     | `/shops/:shopId/views`                             | 204  | 204  | 204   | 204           | 204           |

**#45 だけが公開エンドポイントである。** 閲覧数は匿名ユーザーも含めて数えるので `roleGuard` を掛けない。存在しない `shopId` でも 204 を返す（存在有無を漏らさないため）。DB 側は `shop_id` の FK 違反で INSERT が失敗するので、行は増えない。

**#45 を誰が呼ぶか：** 店舗詳細画面は Phase 6 の担当なので、Phase 8 はエンドポイントと DB だけを用意する。呼び出しの配線は「引き継ぎ」に記載する。したがって Phase 8 完了時点のダッシュボードは、閲覧数が 0 のまま正しく描画できなければならない。Task 8-11 と 8-16 のテストで「全日 0」のケースを必ず通す。

**基本情報と位置の更新は Phase 4 の `PATCH /shops/:shopId`（#8 相当）を使う。** 新設しない。オーナーが自店を更新する経路は既にそこにあり、`updateShopAsOwner` が geohash も書き換える契約になっている。Phase 8 はその回帰テストを足すだけである（Task 8-4）。

---

## タスク数について

**全 23 タスク**（API 14 / モバイル 9）。目安として示された「19 前後」を 4 本上回っている。理由：

1. 設計書 §6 に `campaigns` と `shop_daily_stats` が無く、マイグレーション + 設計書同期テストの更新が独立した 1 タスク（8-1）を要求する。
2. R2 はテスト基盤（miniflare の `r2Buckets`）が未整備で、これも独立した 1 タスク（8-2）になる。写真タスクに畳むと、レビュー担当者が「バインディング整備は OK だがキー生成が NG」という部分否認をできなくなる。
3. KPI 集計は日付バケットの純関数と複数テーブルの `GROUP BY` を含み、他のどのリポジトリとも独立しているので 1 タスク（8-11）にした。
4. HTTP ルートは 32 本ある。1 タスクに畳むと 1 コミットで 6 ファイル・400 行を超え、`docs/CODING_GUIDELINES.md` §3.4 の「200 行を超えたら責務を見直す」に正面から反する。ルート層の**基盤（サブアプリ・ガード・共通ヘルパ）と店舗系ルート**（8-13）と、**残りのルート + 権限マトリクス拡張**（8-14）に割った。基盤が壊れていれば 8-13 で止まり、8-14 まで進まない。

### タスク一覧

| #    | 種別     | 内容                                                                                        |
| ---- | -------- | ------------------------------------------------------------------------------------------- |
| 8-1  | API      | `campaigns` / `shop_daily_stats` のスキーマ・マイグレーション・設計書同期                   |
| 8-2  | API      | R2（`MEDIA`）のテスト基盤とバイト列によるメディア形式判定                                   |
| 8-3  | 共有     | `packages/core` の入力スキーマ（メニュー・営業時間・座席・返信・クーポン等）                |
| 8-4  | API      | 所有権解決（`owner-scope.ts`）と越境不能を証明するテスト土台                                |
| 8-5  | API      | 営業時間・臨時休業リポジトリ                                                                |
| 8-6  | API      | 店舗写真リポジトリ（R2 と D1 の整合）                                                       |
| 8-7  | API      | メニューリポジトリ                                                                          |
| 8-8  | API      | 座席設定リポジトリ                                                                          |
| 8-9  | API      | レビュー一覧・返信・通報リポジトリ                                                          |
| 8-10 | API      | クーポンリポジトリ                                                                          |
| 8-11 | API      | KPI 集計リポジトリと JST 基準の閲覧記録                                                     |
| 8-12 | API      | 店舗申請（書類追加・再提出）リポジトリ                                                      |
| 8-13 | API      | `/owner` サブアプリ基盤 + 店舗・位置・営業時間・座席・写真ルート（#14〜#25, #32, #33）      |
| 8-14 | API      | メニュー・レビュー・クーポン・申請ルート + `POST /shops/:shopId/views` + 権限マトリクス拡張 |
| 8-15 | モバイル | `features/owner`（Zod 応答スキーマ・API 関数・Query フック）                                |
| 8-16 | モバイル | チャート部品（`buildLinePath` + `LineChart` + `KpiCard`）                                   |
| 8-17 | モバイル | 5 タブ化とダッシュボード                                                                    |
| 8-18 | モバイル | 店舗ハブ + 基本情報 + 営業時間 + 座席                                                       |
| 8-19 | モバイル | 位置ピンドラッグ + 写真管理                                                                 |
| 8-20 | モバイル | メニュー一覧・編集                                                                          |
| 8-21 | モバイル | レビュー一覧と返信                                                                          |
| 8-22 | モバイル | クーポン + オンボーディング（審査状況・再提出）                                             |
| 8-23 | モバイル | 総点検（カバレッジ・ミューテーション・型・lint・画面網羅の突合）                            |

---

## Task 8-1: データモデル追加（campaigns / shop_daily_stats）と設計書の同期

**Files:**

- Create: `apps/api/src/db/schema/campaign.ts`
- Create: `apps/api/src/db/schema/stats.ts`
- Create: `apps/api/migrations/0002_campaigns_and_daily_stats.sql`
- Modify: `apps/api/src/db/schema/index.ts`
- Modify: `apps/api/src/db/constants.ts`
- Modify: `apps/api/src/db/schema/index.test.ts`（`DESIGN_DOC_TABLE_NAMES` 配列）
- Modify: `apps/api/migrations/meta/_journal.json`
- Modify: `docs/superpowers/specs/2026-09-15-meshimap-design.md`（§6 のコードブロック）
- Test: `apps/api/src/db/schema/campaign.test.ts`
- Test: `apps/api/src/db/schema/stats.test.ts`

**Interfaces:**

- Consumes: `createMigratedD1()`（`src/db/testing/local-d1.ts`）、`inValues` / `betweenInclusive` / `lengthAtMost` / `matchesGlob` / `atMostColumn`（`src/db/sql-helpers.ts`）、`IDENTIFIER_MAX_LENGTH` / `ISO_DATE_GLOB_PATTERN` / `COUNT_MIN`（`src/db/constants.ts`）
- Produces:
  - `campaigns`（Drizzle テーブル）: 列 `id`, `shopId`, `title`, `body`, `discountType`, `discountValue`, `startsOn`, `endsOn`, `status`, `createdAt`, `updatedAt`
  - `shopDailyStats`（Drizzle テーブル）: 列 `shopId`, `statsDate`, `viewCount`
  - `type CampaignRow = typeof campaigns.$inferSelect`
  - `type ShopDailyStatsRow = typeof shopDailyStats.$inferSelect`
  - `CAMPAIGN_STATUSES = ['draft', 'published', 'ended'] as const`
  - `DISCOUNT_TYPES = ['percent', 'yen', 'gift'] as const`
  - `CAMPAIGN_TITLE_MAX_LENGTH = 60`, `CAMPAIGN_BODY_MAX_LENGTH = 500`, `DISCOUNT_PERCENT_MAX = 100`

### なぜこの 2 テーブルなのか

クーポンは設計書 §5.1 に画面があるのにテーブルが無い。日別閲覧数は、`shops.view_count` が累計しか持たず、しかも Phase 4〜7 のどこにも加算処理が無いため、推移グラフの元データが存在しない。保存数 / 予約数 / 平均評価は既存テーブルの `created_at` を `GROUP BY` すれば出せるので、追加しない。

`shop_daily_stats` は「1 閲覧 1 行」にしない。人気店で行数が無制限に伸びるのを避けるため、`(shop_id, stats_date)` を複合主キーにして `ON CONFLICT DO UPDATE SET view_count = view_count + 1` で潰す。

- [ ] **Step 1: 定数を追加する**

`apps/api/src/db/constants.ts` の末尾に追記する。

```ts
/** クーポンの公開状態。ended は期限切れを手動で閉じた状態 */
export const CAMPAIGN_STATUSES = ['draft', 'published', 'ended'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** 割引の種類。percent は %、yen は円引き、gift は「一品サービス」など金額を伴わないもの */
export const DISCOUNT_TYPES = ['percent', 'yen', 'gift'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

/** 一覧のカードに 2 行で収まる長さ */
export const CAMPAIGN_TITLE_MAX_LENGTH = 60;
export const CAMPAIGN_BODY_MAX_LENGTH = 500;
/** percent のときの上限。100% 超の割引は入力ミスとして弾く */
export const DISCOUNT_PERCENT_MAX = 100;
```

- [ ] **Step 2: campaigns のスキーマテストを書く（失敗する）**

```ts
// apps/api/src/db/schema/campaign.test.ts
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createMigratedD1 } from '../testing/local-d1';
import type { LocalD1 } from '../testing/local-d1';

let local: LocalD1;

beforeAll(async () => {
  local = await createMigratedD1();
});

afterAll(async () => {
  await local.dispose();
});

async function insertShop(id: string): Promise<void> {
  await local.d1
    .prepare(
      `INSERT INTO shops (id, name, name_kana, address, lat, lng, geohash, status, created_at, updated_at)
       VALUES (?, '検証店', 'ケンショウテン', '東京都渋谷区1-1-1', 35.6595, 139.7005, 'xn76fgr', 'published', 0, 0)`,
    )
    .bind(id)
    .run();
}

describe('campaigns テーブル', () => {
  it('正しい行を挿入できる', async () => {
    await insertShop('shp_c1');
    await local.d1
      .prepare(
        `INSERT INTO campaigns (id, shop_id, title, body, discount_type, discount_value, starts_on, ends_on, status, created_at, updated_at)
         VALUES ('cmp_1', 'shp_c1', '開店記念', '全品 10% オフ', 'percent', 10, '2026-10-01', '2026-10-31', 'published', 0, 0)`,
      )
      .run();
    const row = await local.d1
      .prepare(`SELECT status, discount_value FROM campaigns WHERE id = 'cmp_1'`)
      .first<{ status: string; discount_value: number }>();
    expect(row).toEqual({ status: 'published', discount_value: 10 });
  });

  it('starts_on が ends_on より後だと CHECK 違反で拒否する', async () => {
    await insertShop('shp_c2');
    await expect(
      local.d1
        .prepare(
          `INSERT INTO campaigns (id, shop_id, title, body, discount_type, discount_value, starts_on, ends_on, status, created_at, updated_at)
           VALUES ('cmp_2', 'shp_c2', 'ダメ', '', 'yen', 500, '2026-10-31', '2026-10-01', 'draft', 0, 0)`,
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('discount_type が一覧外だと CHECK 違反で拒否する', async () => {
    await insertShop('shp_c3');
    await expect(
      local.d1
        .prepare(
          `INSERT INTO campaigns (id, shop_id, title, body, discount_type, discount_value, starts_on, ends_on, status, created_at, updated_at)
           VALUES ('cmp_3', 'shp_c3', 'ダメ', '', 'bitcoin', 1, '2026-10-01', '2026-10-02', 'draft', 0, 0)`,
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('starts_on が YYYY-MM-DD 形式でないと CHECK 違反で拒否する', async () => {
    await insertShop('shp_c4');
    await expect(
      local.d1
        .prepare(
          `INSERT INTO campaigns (id, shop_id, title, body, discount_type, discount_value, starts_on, ends_on, status, created_at, updated_at)
           VALUES ('cmp_4', 'shp_c4', 'ダメ', '', 'gift', 0, '2026/10/01', '2026-10-02', 'draft', 0, 0)`,
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('店舗を削除するとクーポンも消える（ON DELETE CASCADE）', async () => {
    await insertShop('shp_c5');
    await local.d1
      .prepare(
        `INSERT INTO campaigns (id, shop_id, title, body, discount_type, discount_value, starts_on, ends_on, status, created_at, updated_at)
         VALUES ('cmp_5', 'shp_c5', '消える', '', 'gift', 0, '2026-10-01', '2026-10-02', 'draft', 0, 0)`,
      )
      .run();
    await local.d1.prepare(`DELETE FROM shops WHERE id = 'shp_c5'`).run();
    const row = await local.d1
      .prepare(`SELECT id FROM campaigns WHERE id = 'cmp_5'`)
      .first<{ id: string }>();
    expect(row).toBeNull();
  });
});
```

- [ ] **Step 3: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/api -- src/db/schema/campaign.test.ts`
Expected: FAIL。すべてのケースで `D1_ERROR: no such table: campaigns` を含むエラーになる。

- [ ] **Step 4: campaigns のスキーマを書く**

```ts
// apps/api/src/db/schema/campaign.ts
// クーポン。設計書 §5.1 の (owner)/campaigns/ 2 画面の裏側。
// 期間は「日付」であって時刻を持たない。JST の暦日で判定するため ISO 日付文字列で持つ。
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import {
  CAMPAIGN_BODY_MAX_LENGTH,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TITLE_MAX_LENGTH,
  DISCOUNT_TYPES,
  IDENTIFIER_MAX_LENGTH,
  ISO_DATE_GLOB_PATTERN,
  PRICE_YEN_MIN,
} from '../constants';
import { atLeast, inValues, lengthAtMost, matchesGlob } from '../sql-helpers';
import { shops } from './shop';

export const campaigns = sqliteTable(
  'campaigns',
  {
    id: text('id').primaryKey(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body').notNull(),
    discountType: text('discount_type').notNull(),
    // gift は金額を伴わないので 0 を入れる。型ごとの上限はアプリ側の Zod で見る
    discountValue: integer('discount_value').notNull(),
    startsOn: text('starts_on').notNull(),
    endsOn: text('ends_on').notNull(),
    status: text('status').notNull().default('draft'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (table) => [
    // 一覧は「この店の、この状態のものを開始日順」で引く
    index('idx_campaigns_shop_status').on(table.shopId, table.status, table.startsOn),
    check('ck_campaigns_id_length', lengthAtMost(table.id, IDENTIFIER_MAX_LENGTH)),
    check('ck_campaigns_title_length', lengthAtMost(table.title, CAMPAIGN_TITLE_MAX_LENGTH)),
    check('ck_campaigns_body_length', lengthAtMost(table.body, CAMPAIGN_BODY_MAX_LENGTH)),
    check('ck_campaigns_discount_type', inValues(table.discountType, DISCOUNT_TYPES)),
    check('ck_campaigns_discount_value', atLeast(table.discountValue, PRICE_YEN_MIN)),
    check('ck_campaigns_status', inValues(table.status, CAMPAIGN_STATUSES)),
    check('ck_campaigns_starts_on_format', matchesGlob(table.startsOn, ISO_DATE_GLOB_PATTERN)),
    check('ck_campaigns_ends_on_format', matchesGlob(table.endsOn, ISO_DATE_GLOB_PATTERN)),
    // 日付は文字列だが ISO なので辞書順比較がそのまま日付順比較になる
    check('ck_campaigns_period_order', sql`${table.startsOn} <= ${table.endsOn}`),
  ],
);

export type CampaignRow = typeof campaigns.$inferSelect;
```

- [ ] **Step 5: shop_daily_stats のスキーマを書く**

```ts
// apps/api/src/db/schema/stats.ts
// 日別の閲覧数。1 閲覧 1 行にすると人気店で行が無制限に伸びるので、
// (shop_id, stats_date) を主キーにして UPSERT で加算する。
import { check, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { COUNT_MIN, ISO_DATE_GLOB_PATTERN } from '../constants';
import { atLeast, matchesGlob } from '../sql-helpers';
import { shops } from './shop';

export const shopDailyStats = sqliteTable(
  'shop_daily_stats',
  {
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    // JST の暦日。UTC で切ると日本の 9:00 までが前日に入ってしまう
    statsDate: text('stats_date').notNull(),
    viewCount: integer('view_count').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.shopId, table.statsDate] }),
    check('ck_shop_daily_stats_date_format', matchesGlob(table.statsDate, ISO_DATE_GLOB_PATTERN)),
    check('ck_shop_daily_stats_view_count', atLeast(table.viewCount, COUNT_MIN)),
  ],
);

export type ShopDailyStatsRow = typeof shopDailyStats.$inferSelect;
```

- [ ] **Step 6: stats のスキーマテストを書く（失敗する）**

```ts
// apps/api/src/db/schema/stats.test.ts
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createMigratedD1 } from '../testing/local-d1';
import type { LocalD1 } from '../testing/local-d1';

let local: LocalD1;

beforeAll(async () => {
  local = await createMigratedD1();
  await local.d1
    .prepare(
      `INSERT INTO shops (id, name, name_kana, address, lat, lng, geohash, status, created_at, updated_at)
       VALUES ('shp_s1', '統計店', 'トウケイテン', '東京都渋谷区1-1-1', 35.6595, 139.7005, 'xn76fgr', 'published', 0, 0)`,
    )
    .run();
});

afterAll(async () => {
  await local.dispose();
});

describe('shop_daily_stats テーブル', () => {
  it('同じ (shop_id, stats_date) への UPSERT で view_count が加算される', async () => {
    const upsert = `INSERT INTO shop_daily_stats (shop_id, stats_date, view_count) VALUES ('shp_s1', '2026-09-15', 1)
                    ON CONFLICT (shop_id, stats_date) DO UPDATE SET view_count = view_count + 1`;
    await local.d1.prepare(upsert).run();
    await local.d1.prepare(upsert).run();
    await local.d1.prepare(upsert).run();
    const row = await local.d1
      .prepare(
        `SELECT view_count FROM shop_daily_stats WHERE shop_id = 'shp_s1' AND stats_date = '2026-09-15'`,
      )
      .first<{ view_count: number }>();
    expect(row?.view_count).toBe(3);
  });

  it('日付が変われば別の行になる', async () => {
    await local.d1
      .prepare(
        `INSERT INTO shop_daily_stats (shop_id, stats_date, view_count) VALUES ('shp_s1', '2026-09-16', 1)`,
      )
      .run();
    const rows = await local.d1
      .prepare(
        `SELECT stats_date FROM shop_daily_stats WHERE shop_id = 'shp_s1' ORDER BY stats_date`,
      )
      .all<{ stats_date: string }>();
    expect(rows.results.map((row) => row.stats_date)).toEqual(['2026-09-15', '2026-09-16']);
  });

  it('stats_date が YYYY-MM-DD 形式でないと CHECK 違反で拒否する', async () => {
    await expect(
      local.d1
        .prepare(
          `INSERT INTO shop_daily_stats (shop_id, stats_date, view_count) VALUES ('shp_s1', '20260917', 1)`,
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('存在しない shop_id は外部キー違反で拒否する', async () => {
    await expect(
      local.d1
        .prepare(
          `INSERT INTO shop_daily_stats (shop_id, stats_date, view_count) VALUES ('shp_missing', '2026-09-15', 1)`,
        )
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});
```

- [ ] **Step 7: マイグレーションを生成し、journal を確認する**

Run: `npm run db:generate -w @meshimap/api`
生成されたファイルを `apps/api/migrations/0002_campaigns_and_daily_stats.sql` にリネームし、`apps/api/migrations/meta/_journal.json` の 3 番目のエントリの `tag` を `0002_campaigns_and_daily_stats` に合わせる。journal 全体の `"version": "7"`、各エントリの `"version": "6"`、`"breakpoints": true` は既存 2 エントリと同じ形を保つ。

生成 SQL に以下が含まれることを目視で確認する。

```sql
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	...
	CONSTRAINT "ck_campaigns_period_order" CHECK("campaigns"."starts_on" <= "campaigns"."ends_on")
);
CREATE INDEX `idx_campaigns_shop_status` ON `campaigns` (`shop_id`,`status`,`starts_on`);
CREATE TABLE `shop_daily_stats` (
	`shop_id` text NOT NULL,
	`stats_date` text NOT NULL,
	`view_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`shop_id`, `stats_date`),
	...
);
```

- [ ] **Step 8: barrel と設計書と index.test.ts を同時に更新する**

`apps/api/src/db/schema/index.ts` に追記。

```ts
export * from './campaign';
export * from './stats';
```

`docs/superpowers/specs/2026-09-15-meshimap-design.md` の §6（`## 6. データモデル` と `## 7. ディレクトリ構成` の間のコードブロック）に、既存のテーブル一覧と同じ書式（テーブル名 + 半角スペース 2 個以上 + 説明）で 2 行追加する。

```
campaigns          クーポン（店舗が発行する割引・特典。期間と種別を持つ）
shop_daily_stats   店舗の日別閲覧数（ダッシュボードの推移グラフの元データ）
```

`apps/api/src/db/schema/index.test.ts` の `DESIGN_DOC_TABLE_NAMES` 配列に `'campaigns'` と `'shop_daily_stats'` を追加する。

- [ ] **Step 9: 全部のテストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/api -- src/db/schema/`
Expected: PASS。`campaign.test.ts`（5 件）、`stats.test.ts`（4 件）、`index.test.ts`、`design-doc-sync.test.ts` がすべて緑。

- [ ] **Step 10: わざと壊して検証が効いていることを確認する**

`docs/superpowers/specs/2026-09-15-meshimap-design.md` に足した `shop_daily_stats` の行を**一時的に削除**して `npm run test -w @meshimap/api -- src/db/schema/design-doc-sync.test.ts` を実行する。

Expected: FAIL。期待配列（設計書側）に `shop_daily_stats` が無く、実際の配列（`schema/index.ts` 側）にはある差分が出る。

この確認で「設計書とスキーマが乖離したら CI が落ちる」ことが実証される。**確認したら削除した行を元に戻し、再度テストが緑になることを確認する。**

- [ ] **Step 11: ミューテーションテストを実行する**

Run: `npm run test:mutation -w @meshimap/api`
Expected: スコアが 85 以上。`src/db/schema/**` は Stryker の `mutate` から除外されているので、このタスクで追加したスキーマ自体は変異対象外。`src/db/constants.ts` に足した定数が変異して生き残った場合は、その定数を実際に使う CHECK のテストを足して殺す。**Stryker の設定に除外を足して逃げてはならない。**

- [ ] **Step 12: コミット**

```bash
git add apps/api/src/db/schema/campaign.ts apps/api/src/db/schema/stats.ts \
  apps/api/src/db/schema/campaign.test.ts apps/api/src/db/schema/stats.test.ts \
  apps/api/src/db/schema/index.ts apps/api/src/db/schema/index.test.ts \
  apps/api/src/db/constants.ts apps/api/migrations/ \
  docs/superpowers/specs/2026-09-15-meshimap-design.md
git commit -m "feat(api): campaigns と shop_daily_stats を追加し設計書と同期する"
```

---

## Task 8-2: R2（MEDIA バインディング）の型・テスト基盤・バイト列検証

**Files:**

- Create: `apps/api/src/lib/media.ts`
- Create: `packages/core/src/media.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/index.test.ts`
- Modify: `apps/api/src/types.ts`（Phase 4 が `AppBindings` を定義したファイル。別名なら実物に合わせる）
- Modify: `apps/api/src/db/testing/local-d1.ts`
- Test: `apps/api/src/lib/media.test.ts`

**Interfaces:**

- Consumes: `R2Bucket`（`@cloudflare/workers-types`）、`ShopId` / `UserId`（`@meshimap/core`）、`R2_KEY_ALLOWED_CHARACTERS` / `R2_KEY_MAX_LENGTH`（`apps/api/src/db/constants.ts`）、`createLocalD1()` の miniflare オプション（`src/db/testing/local-d1.ts`）
- Produces:
  - `packages/core`: `UPLOAD_MAX_BYTES = 5_242_880`, `UPLOADABLE_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const`, `UPLOADABLE_DOCUMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const`, `type UploadableImageMimeType`, `type UploadableDocumentMimeType`
  - `apps/api/src/lib/media.ts`:
    - `type DetectedMediaType = { readonly mimeType: string; readonly extension: string }`
    - `function detectMediaType(bytes: Uint8Array): DetectedMediaType | null`
    - `function assertR2Key(key: string): string`（違反で `RangeError`）
    - `function buildShopPhotoKey(shopId: ShopId, uuid: string, extension: string): string`
    - `function buildApplicationDocumentKey(userId: UserId, uuid: string, extension: string): string`
    - `async function putMediaObject(bucket: R2Bucket, key: string, body: ArrayBuffer, mimeType: string): Promise<void>`
    - `async function deleteMediaObject(bucket: R2Bucket, key: string): Promise<void>`
  - （`AppBindings` の `MEDIA: R2Bucket` は Phase 4 が定義済みなので、このタスクでは追加しない）
  - `LocalD1` に `mediaBucket: R2Bucket` が加わる

### なぜバイト列を見るのか

クライアントが送る `Content-Type` はいくらでも偽装できる。`image/jpeg` と名乗る実行ファイルを R2 に置き、CDN 経由で配信する経路を作らないために、先頭バイトで実際の形式を判定する。判定できなければ拒否する（ホワイトリスト方式）。

### なぜ R2 キーを自前で検証するのか（実測に基づく）

`shop_photos.r2_key` には `consistsOf(r2_key, 'a-z0-9/._-')` の CHECK がある（`apps/api/src/db/schema/shop-detail.ts:142`）。一方 `IDENTIFIER_PATTERN` は `/^[A-Za-z0-9_-]+$/` で**大文字を許す**（`packages/core/src/identifier.ts:17`）。大文字を含む `shopId` をキーに埋めると、R2 への `put` は成功するのに D1 の INSERT が CHECK 違反で落ち、R2 に誰も参照しないオブジェクトが残る。`assertR2Key` を `put` の前に必ず通すことで、この孤児を構造的に防ぐ。

- [ ] **Step 1: 共有定数を書く**

```ts
// packages/core/src/media.ts
// アップロードの上限と許可形式。モバイル（事前チェック）と Worker（権威チェック）で共有する。

/** 店舗写真は表示用なので 5MB で十分。モバイル側の事前拒否と Worker 側の Content-Length 検証で同じ値を使う */
export const UPLOAD_MAX_BYTES = 5_242_880;

/** 店舗写真・メニュー写真で受け付ける形式 */
export const UPLOADABLE_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type UploadableImageMimeType = (typeof UPLOADABLE_IMAGE_MIME_TYPES)[number];

/** 申請書類。営業許可証の写真（JPEG/PNG）と PDF を受け付ける */
export const UPLOADABLE_DOCUMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
] as const;
export type UploadableDocumentMimeType = (typeof UPLOADABLE_DOCUMENT_MIME_TYPES)[number];
```

`packages/core/src/index.ts` に `export * from './media';` を追加し、`packages/core/src/index.test.ts` の export 期待一覧に `UPLOAD_MAX_BYTES` / `UPLOADABLE_IMAGE_MIME_TYPES` / `UPLOADABLE_DOCUMENT_MIME_TYPES` を追加する（この 2 ファイルは完全一致で固定されているので同時に直す）。

- [ ] **Step 2: media のテストを書く（失敗する）**

```ts
// apps/api/src/lib/media.test.ts
import { describe, expect, it } from 'vitest';
import { toShopId, toUserId } from '@meshimap/core';

import {
  assertR2Key,
  buildApplicationDocumentKey,
  buildShopPhotoKey,
  detectMediaType,
} from './media';

function bytesOf(...values: readonly number[]): Uint8Array {
  return new Uint8Array(values);
}

describe('detectMediaType', () => {
  it('JPEG のマジックナンバーを認識する', () => {
    expect(detectMediaType(bytesOf(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10))).toEqual({
      mimeType: 'image/jpeg',
      extension: 'jpg',
    });
  });

  it('PNG のマジックナンバーを認識する', () => {
    expect(detectMediaType(bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00))).toEqual({
      mimeType: 'image/png',
      extension: 'png',
    });
  });

  it('RIFF ヘッダの 8 バイト目以降が WEBP なら WebP と認識する', () => {
    const webp = bytesOf(
      0x52,
      0x49,
      0x46,
      0x46,
      0x24,
      0x00,
      0x00,
      0x00,
      0x57,
      0x45,
      0x42,
      0x50,
      0x56,
      0x50,
    );
    expect(detectMediaType(webp)).toEqual({ mimeType: 'image/webp', extension: 'webp' });
  });

  it('RIFF だが WEBP でないものは拒否する（WAV を弾く）', () => {
    const wav = bytesOf(
      0x52,
      0x49,
      0x46,
      0x46,
      0x24,
      0x00,
      0x00,
      0x00,
      0x57,
      0x41,
      0x56,
      0x45,
      0x66,
      0x6d,
    );
    expect(detectMediaType(wav)).toBeNull();
  });

  it('PDF のマジックナンバーを認識する', () => {
    expect(detectMediaType(bytesOf(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37))).toEqual({
      mimeType: 'application/pdf',
      extension: 'pdf',
    });
  });

  it('未知のバイト列は null を返す', () => {
    expect(detectMediaType(bytesOf(0x4d, 0x5a, 0x90, 0x00))).toBeNull();
  });

  it('マジックナンバーより短いバイト列でも例外を投げずに null を返す', () => {
    expect(detectMediaType(bytesOf(0xff, 0xd8))).toBeNull();
    expect(detectMediaType(bytesOf())).toBeNull();
  });

  it('WebP 判定に必要な 12 バイトに 1 バイト足りない入力は null を返す', () => {
    const tooShort = bytesOf(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42);
    expect(detectMediaType(tooShort)).toBeNull();
  });
});

describe('assertR2Key', () => {
  it('許可文字だけのキーはそのまま返す', () => {
    expect(assertR2Key('shop-photos/shp_001/ab12.webp')).toBe('shop-photos/shp_001/ab12.webp');
  });

  it('大文字を含むキーは RangeError を投げる', () => {
    expect(() => assertR2Key('shop-photos/SHP_001/ab12.webp')).toThrow(RangeError);
  });

  it('空白を含むキーは RangeError を投げる', () => {
    expect(() => assertR2Key('shop-photos/shp 001/ab12.webp')).toThrow(RangeError);
  });

  it('200 文字ちょうどは通り、201 文字は RangeError を投げる', () => {
    const base = 'shop-photos/';
    const exact = base + 'a'.repeat(200 - base.length);
    expect(assertR2Key(exact)).toBe(exact);
    expect(() => assertR2Key(exact + 'a')).toThrow(RangeError);
  });
});

describe('buildShopPhotoKey', () => {
  it('<種別>/<id>/<uuid>.<ext> の形で組み立てる', () => {
    const key = buildShopPhotoKey(toShopId('shp_001'), '3f2a4b6c', 'webp');
    expect(key).toBe('shop-photos/shp_001/3f2a4b6c.webp');
  });

  it('大文字の shopId を渡すと RangeError を投げる（R2 に書く前に落とす）', () => {
    expect(() => buildShopPhotoKey(toShopId('SHP_001'), '3f2a4b6c', 'webp')).toThrow(RangeError);
  });
});

describe('buildApplicationDocumentKey', () => {
  it('<種別>/<id>/<uuid>.<ext> の形で組み立てる', () => {
    const key = buildApplicationDocumentKey(toUserId('usr_001'), 'dd01', 'pdf');
    expect(key).toBe('application-documents/usr_001/dd01.pdf');
  });
});
```

- [ ] **Step 3: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/api -- src/lib/media.test.ts`
Expected: FAIL。`Failed to resolve import "./media"` または `Cannot find module './media'` で全件落ちる。

- [ ] **Step 4: media.ts を書く**

```ts
// apps/api/src/lib/media.ts
// アップロードされたバイト列の実形式判定と、R2 キーの組み立て・検証。
// Content-Type ヘッダは偽装できるので、権威ある判定は常に先頭バイトで行う。
import type { ShopId, UserId } from '@meshimap/core';

import { R2_KEY_ALLOWED_CHARACTERS, R2_KEY_MAX_LENGTH } from '../db/constants';

export type DetectedMediaType = { readonly mimeType: string; readonly extension: string };

/** 先頭から固定バイト列を照合するだけで判定できる形式 */
const PREFIX_SIGNATURES: readonly {
  readonly prefix: readonly number[];
  readonly detected: DetectedMediaType;
}[] = [
  { prefix: [0xff, 0xd8, 0xff], detected: { mimeType: 'image/jpeg', extension: 'jpg' } },
  {
    prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    detected: { mimeType: 'image/png', extension: 'png' },
  },
  {
    prefix: [0x25, 0x50, 0x44, 0x46, 0x2d],
    detected: { mimeType: 'application/pdf', extension: 'pdf' },
  },
];

/** WebP は RIFF コンテナなので、先頭 4 バイトだけでは WAV / AVI と区別できない */
const RIFF_PREFIX = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP_FORM_TYPE = [0x57, 0x45, 0x42, 0x50] as const;
const WEBP_FORM_TYPE_OFFSET = 8;
const WEBP_HEADER_LENGTH = 12;

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset: number): boolean {
  if (bytes.length < offset + prefix.length) {
    return false;
  }
  return prefix.every((expected, position) => bytes[offset + position] === expected);
}

export function detectMediaType(bytes: Uint8Array): DetectedMediaType | null {
  for (const signature of PREFIX_SIGNATURES) {
    if (startsWith(bytes, signature.prefix, 0)) {
      return signature.detected;
    }
  }
  if (
    bytes.length >= WEBP_HEADER_LENGTH &&
    startsWith(bytes, RIFF_PREFIX, 0) &&
    startsWith(bytes, WEBP_FORM_TYPE, WEBP_FORM_TYPE_OFFSET)
  ) {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  return null;
}

// db/constants.ts の R2_KEY_ALLOWED_CHARACTERS と同じ文字集合。
// shop_photos.r2_key の CHECK 制約と一字一句そろえる必要があるので、定数から組み立てる
const R2_KEY_PATTERN = new RegExp(`^[${R2_KEY_ALLOWED_CHARACTERS}]+$`);

export function assertR2Key(key: string): string {
  if (key.length === 0 || key.length > R2_KEY_MAX_LENGTH) {
    throw new RangeError(`R2 キーの長さは 1 〜 ${R2_KEY_MAX_LENGTH} 文字である必要があります`);
  }
  if (!R2_KEY_PATTERN.test(key)) {
    throw new RangeError('R2 キーに使用できない文字が含まれています');
  }
  return key;
}

// 接頭辞は docs/CODING_GUIDELINES.md §1.2 の R2 キー規約（`<種別>/<id>/<uuid>.<ext>`、
// 例に `shop-photos/...` が挙がっている）に合わせる。
// seeds/seed.sql のダミー行だけは `shops/shp_001/photo-0.jpg` という別の形をしているが、
// あれは実物の R2 に対応するオブジェクトが存在しない表示確認用の値であり、規約が正とする
const SHOP_PHOTO_KEY_PREFIX = 'shop-photos';
const APPLICATION_DOCUMENT_KEY_PREFIX = 'application-documents';

export function buildShopPhotoKey(shopId: ShopId, uuid: string, extension: string): string {
  // IDENTIFIER_PATTERN は大文字を許すが r2_key の CHECK は許さない。ここで必ず落とす
  return assertR2Key(`${SHOP_PHOTO_KEY_PREFIX}/${shopId}/${uuid}.${extension}`);
}

export function buildApplicationDocumentKey(
  userId: UserId,
  uuid: string,
  extension: string,
): string {
  return assertR2Key(`${APPLICATION_DOCUMENT_KEY_PREFIX}/${userId}/${uuid}.${extension}`);
}

export async function putMediaObject(
  bucket: R2Bucket,
  key: string,
  body: ArrayBuffer,
  mimeType: string,
): Promise<void> {
  await bucket.put(assertR2Key(key), body, { httpMetadata: { contentType: mimeType } });
}

export async function deleteMediaObject(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(assertR2Key(key));
}
```

- [ ] **Step 5: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/api -- src/lib/media.test.ts`
Expected: PASS（16 件）。

- [ ] **Step 6: AppBindings に MEDIA があることを確認する（追記は不要）**

Run: `grep -n 'MEDIA' apps/api/src/lib/app-env.ts`
Expected: `readonly MEDIA: R2Bucket;` が 1 行ヒットする。

`AppBindings` は `apps/api/src/lib/app-env.ts`（`src/types.ts` ではない）にあり、`MEDIA: R2Bucket` は Phase 4 の時点で既に書かれている。**このタスクで型定義を編集してはならない。** grep が空だった場合に限り、`wrangler.jsonc` の `r2_buckets[0].binding`（`MEDIA`）と同じ名前で以下の 1 行を `DB` の次に足す。

```ts
  // wrangler.jsonc の r2_buckets の binding 名と一致させる。
  // Phase 4 の引き継ぎ文書には PHOTOS と書かれていたが、実際の設定は MEDIA なので MEDIA が正
  readonly MEDIA: R2Bucket;
```

- [ ] **Step 7: テスト基盤に R2 を足すテストを書く（失敗する）**

`apps/api/src/db/testing/local-d1.test.ts`（Phase 3 で存在するはず。無ければ新規作成）に追記する。

```ts
it('createMigratedD1 が R2 バケット MEDIA を提供し、put したものを get で読み戻せる', async () => {
  const local = await createMigratedD1();
  try {
    await local.mediaBucket.put('shop-photos/shp_001/a1.png', new Uint8Array([1, 2, 3]).buffer);
    const stored = await local.mediaBucket.get('shop-photos/shp_001/a1.png');
    expect(stored).not.toBeNull();
    const bytes = new Uint8Array(await (stored as R2ObjectBody).arrayBuffer());
    expect([...bytes]).toEqual([1, 2, 3]);
  } finally {
    await local.dispose();
  }
});
```

- [ ] **Step 8: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/api -- src/db/testing/local-d1.test.ts`
Expected: FAIL。`Property 'mediaBucket' does not exist on type 'LocalD1'`（型エラー）、または実行時に `local.mediaBucket is undefined` で `TypeError: Cannot read properties of undefined (reading 'put')`。

- [ ] **Step 9: local-d1.ts に r2Buckets を足す**

`convertV4MiniflareOptions` に渡すオプションへ追記し、`LocalD1` 型と返り値を拡張する。

```ts
const TEST_MEDIA_BUCKET_NAME = 'meshimap-media-test';

// 既存の convertV4MiniflareOptions({ ... }) に r2Buckets を足す
//   d1Databases: { DB: ':memory:' },
//   r2Buckets: { MEDIA: TEST_MEDIA_BUCKET_NAME },

// 既存のプロパティ名は `d1`（`apps/api/src/db/testing/local-d1.ts:26-29` で実測）。
// `database` に改名してはいけない。改名するとコミット済みの
// `src/test/fixtures.ts:40` / `src/db/seed.test.ts`（15 箇所）/ `src/db/client.test.ts:43` /
// `src/db/queries/nearby-shops.test.ts:48` などが一斉に落ちる。ここは mediaBucket を足すだけ
export type LocalD1 = {
  readonly d1: D1Database;
  readonly mediaBucket: R2Bucket;
  readonly dispose: () => Promise<void>;
};

// createLocalD1 の中で
const mediaBucket = await miniflare.getR2Bucket('MEDIA');
return { d1, mediaBucket, dispose };
```

- [ ] **Step 10: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/api -- src/db/testing/local-d1.test.ts`
Expected: PASS。

- [ ] **Step 11: わざと壊して検証が効いていることを確認する**

`assertR2Key` の文字種チェックを一時的に骨抜きにする。

```ts
// 一時的な改悪：正規表現の判定を常に真にする
if (!R2_KEY_PATTERN.test(key) && false) {
```

Run: `npm run test -w @meshimap/api -- src/lib/media.test.ts`
Expected: FAIL。「大文字を含むキーは RangeError を投げる」「空白を含むキーは RangeError を投げる」「大文字の shopId を渡すと RangeError を投げる」の 3 件が `expected function to throw an error, but it didn't` で落ちる。

さらに `detectMediaType` の WebP 分岐から `startsWith(bytes, WEBP_FORM_TYPE, WEBP_FORM_TYPE_OFFSET)` を外すと、「RIFF だが WEBP でないものは拒否する（WAV を弾く）」が `expected { mimeType: 'image/webp', ... } to be null` で落ちる。

**両方確認したら元に戻し、再度テストが緑になることを確認する。**

- [ ] **Step 12: ミューテーションテストを実行する**

Run: `npm run test:mutation -w @meshimap/api`
Expected: スコア 85 以上。`detectMediaType` のオフセット定数（`WEBP_FORM_TYPE_OFFSET = 8` → `9`）や境界（`bytes.length < offset + prefix.length` → `<=`）の変異は、Step 2 で書いた「12 バイトに 1 バイト足りない入力」「マジックナンバーより短いバイト列」のテストが殺す。生き残ったら、殺せる入力を足す。

- [ ] **Step 13: コミット**

```bash
git add packages/core/src/media.ts packages/core/src/index.ts packages/core/src/index.test.ts \
  apps/api/src/lib/media.ts apps/api/src/lib/media.test.ts \
  apps/api/src/types.ts apps/api/src/db/testing/local-d1.ts apps/api/src/db/testing/local-d1.test.ts
git commit -m "feat(api): R2 MEDIA バインディングとバイト列によるメディア形式判定を追加"
```

---

## Task 8-3: packages/core に店舗管理の入力スキーマを追加する

**Files:**

- Modify: `packages/core/src/schema.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/index.test.ts`
- Test: `packages/core/src/schema.test.ts`（既存に追記）

**Interfaces:**

- Consumes: `identifierSchema`, `latitudeSchema`, `longitudeSchema`, `minuteOfDaySchema`, `dayOfWeekSchema`, `budgetYenSchema`, `businessHoursSchema`（いずれも `packages/core/src/schema.ts` の既存）、`CAMPAIGN_TITLE_MAX_LENGTH` などは core 側で独自に定義する（core は `apps/api` に依存できないため）
- Produces（すべて `packages/core` の barrel から export）:
  - `menuCategoryCreateSchema` → `{ name: string; sortOrder: number }`
  - `menuItemInputSchema` → `{ name: string; description: string | null; priceYen: number; categoryId: string | null; isRecommended: boolean; sortOrder: number }`
  - `shopHoursInputSchema` → `{ entries: readonly { dayOfWeek: number; openMinute: number | null; closeMinute: number | null; isClosed: boolean }[] }`
  - `shopClosureCreateSchema` → `{ closedOn: string; reason: string | null }`
  - `seatSettingsInputSchema` → `{ capacity: number; slotMinutes: number; maxParallel: number; acceptsReservation: boolean }`
  - `reviewReplyInputSchema` → `{ body: string }`
  - `reviewReportCreateSchema` → `{ reason: string; detail: string | null }`
  - `campaignInputSchema` → `{ title: string; body: string; discountType: 'percent' | 'yen' | 'gift'; discountValue: number; startsOn: string; endsOn: string; status: 'draft' | 'published' | 'ended' }`
  - `photoCaptionUpdateSchema` → `{ caption: string | null; isCover: boolean }`
  - `photoOrderUpdateSchema` → `{ photoIds: readonly string[] }`
  - `applicationResubmitSchema` → `{ note: string }`
  - 対応する型 `MenuItemInput` / `ShopHoursInput` / `SeatSettingsInput` / `CampaignInput` など（`z.infer` から）
  - 定数 `MENU_CATEGORY_NAME_MAX = 50`, `MENU_ITEM_NAME_MAX = 100`, `MENU_ITEM_DESCRIPTION_MAX = 500`, `REVIEW_REPLY_BODY_MAX = 1000`, `CAMPAIGN_TITLE_MAX = 60`, `CAMPAIGN_BODY_MAX = 500`, `PHOTO_CAPTION_MAX = 200`, `CLOSURE_REASON_MAX = 100`, `RESUBMIT_NOTE_MAX = 1000`

### なぜ core に置くのか

判断 5 のとおり。モバイルのフォーム検証（react-hook-form + zodResolver）と API の受け口検証がまったく同じスキーマを使うことで、「モバイルは通るが API が 422」という食い違いが構造的に起きなくなる。既に `shopCreateSchema` / `shopUpdateSchema` / `businessHoursSchema` が core にある以上、新規スキーマだけ別の場所に置くのは一貫性を壊す。

**注意：** `packages/core` は `apps/api` に依存できない（依存の向きが逆）。長さ上限は core 側で独自に定義し、`apps/api/src/db/constants.ts` の同名定数と**値をそろえる**。値のズレは Task 8-4 以降の統合テスト（DB の CHECK に到達する経路）で検出される。

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/src/schema.test.ts` に追記する。

```ts
describe('menuItemInputSchema', () => {
  it('必須項目が揃っていれば parse できる', () => {
    const parsed = menuItemInputSchema.parse({
      name: '特製ラーメン',
      description: '濃厚豚骨',
      priceYen: 980,
      categoryId: 'mct_001',
      isRecommended: true,
      sortOrder: 0,
    });
    expect(parsed.priceYen).toBe(980);
  });

  it('価格 0 円は許可する（サービス品の想定）', () => {
    expect(
      menuItemInputSchema.parse({
        name: 'お通し',
        description: null,
        priceYen: 0,
        categoryId: null,
        isRecommended: false,
        sortOrder: 0,
      }).priceYen,
    ).toBe(0);
  });

  it('価格が負なら拒否する', () => {
    expect(() =>
      menuItemInputSchema.parse({
        name: 'バグ',
        description: null,
        priceYen: -1,
        categoryId: null,
        isRecommended: false,
        sortOrder: 0,
      }),
    ).toThrow();
  });

  it('価格が 1000000 ちょうどは通り、1000001 は拒否する', () => {
    const base = {
      name: '会席',
      description: null,
      categoryId: null,
      isRecommended: false,
      sortOrder: 0,
    };
    expect(menuItemInputSchema.parse({ ...base, priceYen: 1_000_000 }).priceYen).toBe(1_000_000);
    expect(() => menuItemInputSchema.parse({ ...base, priceYen: 1_000_001 })).toThrow();
  });

  it('価格が小数なら拒否する', () => {
    expect(() =>
      menuItemInputSchema.parse({
        name: 'バグ',
        description: null,
        priceYen: 980.5,
        categoryId: null,
        isRecommended: false,
        sortOrder: 0,
      }),
    ).toThrow();
  });

  it('名前が空文字なら拒否する', () => {
    expect(() =>
      menuItemInputSchema.parse({
        name: '',
        description: null,
        priceYen: 100,
        categoryId: null,
        isRecommended: false,
        sortOrder: 0,
      }),
    ).toThrow();
  });

  it('名前が 100 文字ちょうどは通り、101 文字は拒否する', () => {
    const base = {
      description: null,
      priceYen: 100,
      categoryId: null,
      isRecommended: false,
      sortOrder: 0,
    };
    expect(menuItemInputSchema.parse({ ...base, name: 'あ'.repeat(100) }).name).toHaveLength(100);
    expect(() => menuItemInputSchema.parse({ ...base, name: 'あ'.repeat(101) })).toThrow();
  });
});

describe('campaignInputSchema', () => {
  const base = {
    title: '開店記念',
    body: '全品 10% オフ',
    discountType: 'percent' as const,
    discountValue: 10,
    startsOn: '2026-10-01',
    endsOn: '2026-10-31',
    status: 'published' as const,
  };

  it('正しい入力は parse できる', () => {
    expect(campaignInputSchema.parse(base).discountType).toBe('percent');
  });

  it('開始日と終了日が同じ日は許可する（1 日だけのクーポン）', () => {
    expect(
      campaignInputSchema.parse({ ...base, startsOn: '2026-10-01', endsOn: '2026-10-01' }).endsOn,
    ).toBe('2026-10-01');
  });

  it('開始日が終了日より後なら拒否する', () => {
    expect(() =>
      campaignInputSchema.parse({ ...base, startsOn: '2026-11-01', endsOn: '2026-10-01' }),
    ).toThrow();
  });

  it('percent で 100 ちょうどは通り、101 は拒否する', () => {
    expect(campaignInputSchema.parse({ ...base, discountValue: 100 }).discountValue).toBe(100);
    expect(() => campaignInputSchema.parse({ ...base, discountValue: 101 })).toThrow();
  });

  it('yen なら 101 以上でも通る（円引きに 100 の上限は無い）', () => {
    expect(
      campaignInputSchema.parse({ ...base, discountType: 'yen', discountValue: 500 }).discountValue,
    ).toBe(500);
  });

  it('gift は discountValue が 0 でなければ拒否する', () => {
    expect(
      campaignInputSchema.parse({ ...base, discountType: 'gift', discountValue: 0 }).discountValue,
    ).toBe(0);
    expect(() =>
      campaignInputSchema.parse({ ...base, discountType: 'gift', discountValue: 1 }),
    ).toThrow();
  });

  it('存在しない日付（2026-02-30）は拒否する', () => {
    expect(() => campaignInputSchema.parse({ ...base, startsOn: '2026-02-30' })).toThrow();
  });
});

describe('shopHoursInputSchema', () => {
  it('同じ曜日に 2 行（中休みあり）を許可する', () => {
    const parsed = shopHoursInputSchema.parse({
      entries: [
        { dayOfWeek: 1, openMinute: 660, closeMinute: 840, isClosed: false },
        { dayOfWeek: 1, openMinute: 1020, closeMinute: 1320, isClosed: false },
      ],
    });
    expect(parsed.entries).toHaveLength(2);
  });

  it('isClosed が true なら openMinute / closeMinute は null でなければ拒否する', () => {
    expect(() =>
      shopHoursInputSchema.parse({
        entries: [{ dayOfWeek: 0, openMinute: 660, closeMinute: 840, isClosed: true }],
      }),
    ).toThrow();
  });

  it('isClosed が false なら openMinute / closeMinute は必須', () => {
    expect(() =>
      shopHoursInputSchema.parse({
        entries: [{ dayOfWeek: 0, openMinute: null, closeMinute: null, isClosed: false }],
      }),
    ).toThrow();
  });

  it('日跨ぎ（開店 1320 / 閉店 1560 = 翌 02:00）を許可する', () => {
    const parsed = shopHoursInputSchema.parse({
      entries: [{ dayOfWeek: 5, openMinute: 1320, closeMinute: 1560, isClosed: false }],
    });
    expect(parsed.entries[0]?.closeMinute).toBe(1560);
  });

  it('開店と閉店が同時刻なら拒否する（営業時間 0 分）', () => {
    expect(() =>
      shopHoursInputSchema.parse({
        entries: [{ dayOfWeek: 2, openMinute: 660, closeMinute: 660, isClosed: false }],
      }),
    ).toThrow();
  });

  it('entries が空配列でも通る（全曜日未設定 = 全削除）', () => {
    expect(shopHoursInputSchema.parse({ entries: [] }).entries).toEqual([]);
  });
});

describe('seatSettingsInputSchema', () => {
  it('capacity が 1 ちょうどは通り、0 は拒否する', () => {
    const base = { slotMinutes: 90, maxParallel: 1, acceptsReservation: true };
    expect(seatSettingsInputSchema.parse({ ...base, capacity: 1 }).capacity).toBe(1);
    expect(() => seatSettingsInputSchema.parse({ ...base, capacity: 0 })).toThrow();
  });

  it('slotMinutes が 15 未満なら拒否する', () => {
    expect(() =>
      seatSettingsInputSchema.parse({
        capacity: 10,
        slotMinutes: 14,
        maxParallel: 1,
        acceptsReservation: true,
      }),
    ).toThrow();
  });

  it('slotMinutes が 240 ちょうどは通る', () => {
    expect(
      seatSettingsInputSchema.parse({
        capacity: 10,
        slotMinutes: 240,
        maxParallel: 1,
        acceptsReservation: true,
      }).slotMinutes,
    ).toBe(240);
  });

  it('maxParallel が capacity を超えても通る（席を分割して同時受付する運用を許す）', () => {
    expect(
      seatSettingsInputSchema.parse({
        capacity: 2,
        slotMinutes: 90,
        maxParallel: 5,
        acceptsReservation: true,
      }).maxParallel,
    ).toBe(5);
  });
});

describe('photoOrderUpdateSchema', () => {
  it('ID が重複していたら拒否する', () => {
    expect(() => photoOrderUpdateSchema.parse({ photoIds: ['pht_1', 'pht_1'] })).toThrow();
  });

  it('重複が無ければ通る', () => {
    expect(photoOrderUpdateSchema.parse({ photoIds: ['pht_1', 'pht_2'] }).photoIds).toHaveLength(2);
  });

  it('空配列は拒否する（並べ替えの対象が無い）', () => {
    expect(() => photoOrderUpdateSchema.parse({ photoIds: [] })).toThrow();
  });
});

describe('reviewReplyInputSchema', () => {
  it('空文字は拒否する', () => {
    expect(() => reviewReplyInputSchema.parse({ body: '' })).toThrow();
  });

  it('空白だけの本文は拒否する', () => {
    expect(() => reviewReplyInputSchema.parse({ body: '   \n ' })).toThrow();
  });

  it('前後の空白は落として保存する', () => {
    expect(reviewReplyInputSchema.parse({ body: '  ご来店ありがとうございます  ' }).body).toBe(
      'ご来店ありがとうございます',
    );
  });

  it('1000 文字ちょうどは通り、1001 文字は拒否する', () => {
    expect(reviewReplyInputSchema.parse({ body: 'あ'.repeat(1000) }).body).toHaveLength(1000);
    expect(() => reviewReplyInputSchema.parse({ body: 'あ'.repeat(1001) })).toThrow();
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/core -- src/schema.test.ts`
Expected: FAIL。`ReferenceError: menuItemInputSchema is not defined`（および他のスキーマ名についても同様）。

- [ ] **Step 3: スキーマを実装する**

`packages/core/src/schema.ts` に追記する。

```ts
/** メニューカテゴリ名。一覧の見出しに 1 行で収まる長さ */
export const MENU_CATEGORY_NAME_MAX = 50;
export const MENU_ITEM_NAME_MAX = 100;
export const MENU_ITEM_DESCRIPTION_MAX = 500;
export const REVIEW_REPLY_BODY_MAX = 1000;
export const CAMPAIGN_TITLE_MAX = 60;
export const CAMPAIGN_BODY_MAX = 500;
export const PHOTO_CAPTION_MAX = 200;
export const CLOSURE_REASON_MAX = 100;
export const RESUBMIT_NOTE_MAX = 1000;
export const REPORT_REASON_MAX = 100;
export const REPORT_DETAIL_MAX = 1000;
/** percent 割引の上限。100% を超える割引は入力ミス */
export const DISCOUNT_PERCENT_MAX_VALUE = 100;
/** gift（一品サービス等）は金額を伴わないので値は 0 固定 */
export const GIFT_DISCOUNT_VALUE = 0;

export const menuCategoryCreateSchema = z.object({
  name: z.string().trim().min(1).max(MENU_CATEGORY_NAME_MAX),
  sortOrder: z.number().int().min(0),
});

export const menuItemInputSchema = z.object({
  name: z.string().trim().min(1).max(MENU_ITEM_NAME_MAX),
  description: z.string().trim().max(MENU_ITEM_DESCRIPTION_MAX).nullable(),
  priceYen: z.number().int().min(0).max(1_000_000),
  categoryId: identifierSchema.nullable(),
  isRecommended: z.boolean(),
  sortOrder: z.number().int().min(0),
});
export type MenuItemInput = z.infer<typeof menuItemInputSchema>;

const shopHoursEntrySchema = z
  .object({
    dayOfWeek: dayOfWeekSchema,
    openMinute: minuteOfDaySchema.nullable(),
    closeMinute: minuteOfDaySchema.nullable(),
    isClosed: z.boolean(),
  })
  // DB の ck_shop_hours_closed_coherence と同じ規則。休業日に時刻が残っていると
  // 「休みなのに営業中」と表示されるので、入力の時点で揃える
  .refine(
    (entry) =>
      entry.isClosed
        ? entry.openMinute === null && entry.closeMinute === null
        : entry.openMinute !== null && entry.closeMinute !== null,
    { message: '休業日は時刻を空に、営業日は開店と閉店の両方を指定してください' },
  )
  .refine(
    (entry) =>
      entry.openMinute === null ||
      entry.closeMinute === null ||
      entry.openMinute < entry.closeMinute,
    { message: '閉店時刻は開店時刻より後である必要があります' },
  );

export const shopHoursInputSchema = z.object({
  // 同じ曜日に複数行を許す。中休みのある店は 1 曜日 2 行になる
  entries: z.array(shopHoursEntrySchema),
});
export type ShopHoursInput = z.infer<typeof shopHoursInputSchema>;

/** 存在しない日付（2026-02-30 など）を往復比較で弾く。new Date は勝手に繰り上げる */
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) => {
      const parsed = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime())) {
        return false;
      }
      return parsed.toISOString().slice(0, 10) === value;
    },
    { message: '存在しない日付です' },
  );

export const shopClosureCreateSchema = z.object({
  closedOn: isoDateSchema,
  reason: z.string().trim().max(CLOSURE_REASON_MAX).nullable(),
});

export const seatSettingsInputSchema = z.object({
  capacity: z.number().int().min(1).max(500),
  slotMinutes: z.number().int().min(15).max(240),
  maxParallel: z.number().int().min(1).max(100),
  acceptsReservation: z.boolean(),
});
export type SeatSettingsInput = z.infer<typeof seatSettingsInputSchema>;

export const reviewReplyInputSchema = z.object({
  body: z.string().trim().min(1).max(REVIEW_REPLY_BODY_MAX),
});

export const reviewReportCreateSchema = z.object({
  reason: z.string().trim().min(1).max(REPORT_REASON_MAX),
  detail: z.string().trim().max(REPORT_DETAIL_MAX).nullable(),
});

export const campaignInputSchema = z
  .object({
    title: z.string().trim().min(1).max(CAMPAIGN_TITLE_MAX),
    body: z.string().trim().max(CAMPAIGN_BODY_MAX),
    discountType: z.enum(['percent', 'yen', 'gift']),
    discountValue: z.number().int().min(0).max(1_000_000),
    startsOn: isoDateSchema,
    endsOn: isoDateSchema,
    status: z.enum(['draft', 'published', 'ended']),
  })
  // ISO 日付は辞書順比較がそのまま日付順比較になる。DB の ck_campaigns_period_order と同じ規則。
  // path を付けないとエラーがオブジェクト全体に付き、react-hook-form が
  // どの Input にも errorMessage を渡せなくなる（画面に何も出ない）ので必ず付ける
  .refine((input) => input.startsOn <= input.endsOn, {
    message: '終了日は開始日以降である必要があります',
    path: ['endsOn'],
  })
  .refine(
    (input) =>
      input.discountType !== 'percent' || input.discountValue <= DISCOUNT_PERCENT_MAX_VALUE,
    { message: '割引率は 100% 以下である必要があります' },
  )
  .refine((input) => input.discountType !== 'gift' || input.discountValue === GIFT_DISCOUNT_VALUE, {
    message: '特典サービスに割引額は指定できません',
  });
export type CampaignInput = z.infer<typeof campaignInputSchema>;

export const photoCaptionUpdateSchema = z.object({
  caption: z.string().trim().max(PHOTO_CAPTION_MAX).nullable(),
  isCover: z.boolean(),
});

export const photoOrderUpdateSchema = z.object({
  photoIds: z
    .array(identifierSchema)
    .min(1)
    // 同じ ID が 2 回出ると sort_order が壊れるので、並べ替え要求の時点で弾く
    .refine((ids) => new Set(ids).size === ids.length, { message: '写真 ID が重複しています' }),
});

export const applicationResubmitSchema = z.object({
  note: z.string().trim().min(1).max(RESUBMIT_NOTE_MAX),
});
```

- [ ] **Step 4: barrel と export 一覧テストを更新する**

`packages/core/src/index.ts` に新規 export を追加する（`export * from './schema'` で済むなら追加不要だが、barrel が名前を列挙している場合はすべて列挙する）。`packages/core/src/index.test.ts` の期待 export 一覧に、Step 3 で足したスキーマ名・型名・定数名をすべて追加する。

- [ ] **Step 5: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/core`
Expected: PASS。`schema.test.ts` の新規 34 件と `index.test.ts` が緑。

- [ ] **Step 6: わざと壊して検証が効いていることを確認する**

`campaignInputSchema` の期間チェックを `input.startsOn < input.endsOn`（`<=` を `<` に）へ一時的に変更する。

Run: `npm run test -w @meshimap/core -- src/schema.test.ts`
Expected: FAIL。「開始日と終了日が同じ日は許可する（1 日だけのクーポン）」が `ZodError` で落ちる。1 日限りのクーポンという実在の運用を壊す変更が検出される。

次に `shopHoursEntrySchema` の 2 番目の `refine` を削除する。
Expected: FAIL。「開店と閉店が同時刻なら拒否する（営業時間 0 分）」が `expected function to throw` で落ちる。

**両方確認したら元に戻し、再度テストが緑になることを確認する。**

- [ ] **Step 7: ミューテーションテストを実行する**

Run: `npm run test:mutation -w @meshimap/core`
Expected: スコア 85 以上。`.max(MENU_ITEM_NAME_MAX)` の境界変異（`100` → `101`）は Step 1 の「100 文字ちょうどは通り、101 文字は拒否する」が殺す。`DISCOUNT_PERCENT_MAX_VALUE` の変異は「percent で 100 ちょうどは通り、101 は拒否する」が殺す。

- [ ] **Step 8: コミット**

```bash
git add packages/core/src/schema.ts packages/core/src/schema.test.ts \
  packages/core/src/index.ts packages/core/src/index.test.ts
git commit -m "feat(core): 店舗管理フォームの入力スキーマを追加する"
```

---

## Task 8-4: 所有権スコープの土台と「越境できない」ことの証明

**Files:**

- Create: `apps/api/src/repositories/owner-scope.ts`
- Create: `apps/api/src/repositories/owner-scope.test.ts`
- Create: `apps/api/src/repositories/testing/owner-fixtures.ts`
- Test: `apps/api/src/repositories/shop-repository.ownership.test.ts`（Phase 4 の `updateShopAsOwner` への回帰テスト）

**Interfaces:**

- Consumes: `OwnerActor`（Phase 4）、`Database`（Phase 4 の Drizzle 型）、`ShopId` / `ReviewId` / `toShopId`（core）、`campaigns`（Task 8-1）、`createMigratedD1()`（Phase 3）、`updateShopAsOwner(db, actor, shopId, input)`（Phase 4）、`coordinate` / `encodeGeohash`（`@meshimap/geo`）、`SHOP_GEOHASH_PRECISION`（api constants）
- Produces:
  - `async function findOwnedShopId(db: Database, actor: OwnerActor, shopId: ShopId): Promise<ShopId | null>`
  - `async function findOwnedReviewShopId(db: Database, actor: OwnerActor, reviewId: ReviewId): Promise<ShopId | null>`
  - `async function findOwnedCampaignShopId(db: Database, actor: OwnerActor, campaignId: string): Promise<ShopId | null>`
  - `async function findOwnedShopLocation(db: Database, actor: OwnerActor, shopId: ShopId): Promise<{ readonly lat: number; readonly lng: number } | null>`
  - `apps/api/src/repositories/testing/owner-fixtures.ts`:
    - `type OwnerFixture = { readonly actor: OwnerActor; readonly userId: UserId; readonly shopId: ShopId }`
    - `async function seedTwoOwners(local: LocalD1): Promise<{ readonly alice: OwnerFixture; readonly bob: OwnerFixture }>`
    - `async function readShopRow(local: LocalD1, shopId: ShopId): Promise<Record<string, unknown> | null>`

### このタスクが Phase 8 の中核である

「オーナー A がオーナー B の店を触れない」ことは、実装後に目視で確認するものではなく、**テストで証明するもの**である。しかも戻り値が `null` であることを確認するだけでは足りない。「書き込んでから null を返す」実装を見逃すからである。したがって**書き込み前後で DB の行全体をスナップショット比較する**。

- [ ] **Step 1: 2 オーナーのフィクスチャを書く**

```ts
// apps/api/src/repositories/testing/owner-fixtures.ts
// 越境テスト用の最小データ。オーナー 2 人がそれぞれ 1 店舗を持つ。
import { toShopId, toUserId } from '@meshimap/core';
import type { ShopId, UserId } from '@meshimap/core';

import { coordinate, encodeGeohash } from '@meshimap/geo';

import { SHOP_GEOHASH_PRECISION } from '../../db/constants';
import type { LocalD1 } from '../../db/testing/local-d1';
import type { OwnerActor } from '../../auth/actor';

export type OwnerFixture = {
  readonly actor: OwnerActor;
  readonly userId: UserId;
  readonly shopId: ShopId;
};

/** Phase 4 の認証ミドルウェアを経由せずに OwnerActor を作る、テスト専用の生成関数。
 *  Phase 4 が提供する testing 用ファクトリ（あれば）をそのまま使い、無ければそこに追加する。 */
import { createOwnerActorForTest } from '../../auth/testing/actor-factory';

async function insertOwner(
  local: LocalD1,
  userId: string,
  shopId: string,
  lat: number,
  lng: number,
  geohash: string,
): Promise<OwnerFixture> {
  await local.d1
    .prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)`,
    )
    .bind(userId, `オーナー${userId}`, `${userId}@example.com`)
    .run();
  await local.d1
    .prepare(
      // profiles に updated_at 列は無い（apps/api/src/db/schema/master.ts で実測）
      `INSERT INTO profiles (user_id, role, status, display_name, created_at) VALUES (?, 'owner', 'active', ?, 0)`,
    )
    .bind(userId, `オーナー${userId}`)
    .run();
  await local.d1
    .prepare(
      `INSERT INTO shops (id, owner_id, name, name_kana, address, lat, lng, geohash, status, created_at, updated_at)
       VALUES (?, ?, ?, 'テンポ', '東京都渋谷区1-1-1', ?, ?, ?, 'published', 0, 0)`,
    )
    .bind(shopId, userId, `${shopId} の店`, lat, lng, geohash)
    .run();
  const typedUserId = toUserId(userId);
  return {
    actor: createOwnerActorForTest(typedUserId),
    userId: typedUserId,
    shopId: toShopId(shopId),
  };
}

/**
 * seed に使う座標。テストの期待値もここから読む。
 * テスト側でリテラルを書き直すと、seed を変えたときにテストだけが古い値を持ち続ける。
 */
export const ALICE_SHOP_LAT = 35.6595;
export const ALICE_SHOP_LNG = 139.7005;
export const BOB_SHOP_LAT = 35.6812;
export const BOB_SHOP_LNG = 139.7671;

export async function seedTwoOwners(
  local: LocalD1,
): Promise<{ readonly alice: OwnerFixture; readonly bob: OwnerFixture }> {
  // geohash は encodeGeohash の出力をそのまま使う。手書きの文字列を置くと、
  // 精度定数を変えたときに seed だけが古い長さのまま残る
  const alice = await insertOwner(
    local,
    'usr_alice',
    'shp_alice',
    ALICE_SHOP_LAT,
    ALICE_SHOP_LNG,
    encodeGeohash(coordinate(ALICE_SHOP_LAT, ALICE_SHOP_LNG), SHOP_GEOHASH_PRECISION),
  );
  const bob = await insertOwner(
    local,
    'usr_bob',
    'shp_bob',
    BOB_SHOP_LAT,
    BOB_SHOP_LNG,
    encodeGeohash(coordinate(BOB_SHOP_LAT, BOB_SHOP_LNG), SHOP_GEOHASH_PRECISION),
  );
  return { alice, bob };
}

/** 行全体を素の Record で読む。列を 1 つでも書き換えられたら差分が出る */
export async function readShopRow(
  local: LocalD1,
  shopId: ShopId,
): Promise<Record<string, unknown> | null> {
  return await local.d1.prepare(`SELECT * FROM shops WHERE id = ?`).bind(shopId).first();
}
```

- [ ] **Step 2: owner-scope のテストを書く（失敗する）**

```ts
// apps/api/src/repositories/owner-scope.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toShopId, toReviewId } from '@meshimap/core';

import { createMigratedD1 } from '../db/testing/local-d1';
import type { LocalD1 } from '../db/testing/local-d1';
import { createDatabase } from '../db/client';
import type { Database } from '../db/client';
import { ALICE_SHOP_LAT, ALICE_SHOP_LNG, seedTwoOwners } from './testing/owner-fixtures';
import type { OwnerFixture } from './testing/owner-fixtures';
import {
  findOwnedCampaignShopId,
  findOwnedReviewShopId,
  findOwnedShopId,
  findOwnedShopLocation,
} from './owner-scope';

let local: LocalD1;
let db: Database;
let alice: OwnerFixture;
let bob: OwnerFixture;

beforeEach(async () => {
  local = await createMigratedD1();
  db = createDatabase(local.d1);
  const seeded = await seedTwoOwners(local);
  alice = seeded.alice;
  bob = seeded.bob;
});

afterEach(async () => {
  await local.dispose();
});

describe('findOwnedShopId', () => {
  it('自分の店なら shopId を返す', async () => {
    expect(await findOwnedShopId(db, alice.actor, alice.shopId)).toBe(alice.shopId);
  });

  it('他人の店なら null を返す', async () => {
    expect(await findOwnedShopId(db, alice.actor, bob.shopId)).toBeNull();
  });

  it('存在しない店なら null を返す（他人の店と区別がつかない）', async () => {
    expect(await findOwnedShopId(db, alice.actor, toShopId('shp_nowhere'))).toBeNull();
  });

  it('owner_id が NULL の店（オーナー未割当）は誰のものでもない', async () => {
    await local.d1
      .prepare(
        `INSERT INTO shops (id, owner_id, name, name_kana, address, lat, lng, geohash, status, created_at, updated_at)
         VALUES ('shp_orphan', NULL, '無主の店', 'ムシュノミセ', '東京都港区1-1-1', 35.66, 139.73, 'xn76gg0', 'published', 0, 0)`,
      )
      .run();
    expect(await findOwnedShopId(db, alice.actor, toShopId('shp_orphan'))).toBeNull();
  });
});

describe('findOwnedReviewShopId', () => {
  beforeEach(async () => {
    await local.d1
      .prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('usr_guest', 'ゲスト', 'guest@example.com', 1, 0, 0)`,
      )
      .run();
    await local.d1
      .prepare(
        // reviews に updated_at 列は無い（apps/api/src/db/schema/review.ts:65 は created_at のみ）
        `INSERT INTO reviews (id, shop_id, user_id, rating, body, status, created_at)
         VALUES ('rvw_alice', 'shp_alice', 'usr_guest', 5, 'おいしい', 'published', 0)`,
      )
      .run();
  });

  it('自分の店に付いたレビューなら shopId を返す', async () => {
    expect(await findOwnedReviewShopId(db, alice.actor, toReviewId('rvw_alice'))).toBe(
      alice.shopId,
    );
  });

  it('他人の店に付いたレビューなら null を返す', async () => {
    expect(await findOwnedReviewShopId(db, bob.actor, toReviewId('rvw_alice'))).toBeNull();
  });

  it('存在しないレビューなら null を返す', async () => {
    expect(await findOwnedReviewShopId(db, alice.actor, toReviewId('rvw_nowhere'))).toBeNull();
  });
});

describe('findOwnedCampaignShopId', () => {
  beforeEach(async () => {
    await local.d1
      .prepare(
        `INSERT INTO campaigns (id, shop_id, title, body, discount_type, discount_value, starts_on, ends_on, status, created_at, updated_at)
         VALUES ('cmp_alice', 'shp_alice', '記念', '', 'gift', 0, '2026-10-01', '2026-10-31', 'draft', 0, 0)`,
      )
      .run();
  });

  it('自分の店のクーポンなら shopId を返す', async () => {
    expect(await findOwnedCampaignShopId(db, alice.actor, 'cmp_alice')).toBe(alice.shopId);
  });

  it('他人の店のクーポンなら null を返す', async () => {
    expect(await findOwnedCampaignShopId(db, bob.actor, 'cmp_alice')).toBeNull();
  });

  it('存在しないクーポンなら null を返す', async () => {
    expect(await findOwnedCampaignShopId(db, alice.actor, 'cmp_nowhere')).toBeNull();
  });
});
```

- [ ] **Step 3: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/api -- src/repositories/owner-scope.test.ts`
Expected: FAIL。`Failed to resolve import "./owner-scope"` で全 14 件が落ちる。

- [ ] **Step 4: owner-scope.ts を実装する**

```ts
// apps/api/src/repositories/owner-scope.ts
// 所有権は SQL の WHERE owner_id = ? で表現する。
// 「他人の店」も「存在しない店」も 0 行になるので、呼び出し側は両者を区別できない。
// 区別できないことが目的であり、これによって ID の存在有無が応答から漏れない。
import { and, eq } from 'drizzle-orm';
import { toShopId } from '@meshimap/core';
import type { ReviewId, ShopId } from '@meshimap/core';

import type { OwnerActor } from '../auth/actor';
import type { Database } from '../db/client';
import { campaigns, reviews, shops } from '../db/schema';

export async function findOwnedShopId(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
): Promise<ShopId | null> {
  const rows = await db
    .select({ id: shops.id })
    .from(shops)
    .where(and(eq(shops.id, shopId), eq(shops.ownerId, actor.userId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toShopId(row.id);
}

/** レビュー返信は URL に shopId を含まない。ID からオーナーへ遡る経路をここに 1 本だけ置く */
export async function findOwnedReviewShopId(
  db: Database,
  actor: OwnerActor,
  reviewId: ReviewId,
): Promise<ShopId | null> {
  const rows = await db
    .select({ shopId: reviews.shopId })
    .from(reviews)
    .innerJoin(shops, eq(shops.id, reviews.shopId))
    .where(and(eq(reviews.id, reviewId), eq(shops.ownerId, actor.userId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toShopId(row.shopId);
}

export async function findOwnedCampaignShopId(
  db: Database,
  actor: OwnerActor,
  campaignId: string,
): Promise<ShopId | null> {
  const rows = await db
    .select({ shopId: campaigns.shopId })
    .from(campaigns)
    .innerJoin(shops, eq(shops.id, campaigns.shopId))
    .where(and(eq(campaigns.id, campaignId), eq(shops.ownerId, actor.userId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toShopId(row.shopId);
}

/**
 * 地図ピン編集画面のための読み取り。
 * 店舗詳細（Phase 4 の GET /shops/:shopId）は公開向けの整形済み応答なので、
 * 編集用に生の lat/lng だけが欲しいこの用途には使わない。
 * geohash は返さない。クライアントが導出値を持つと、送り返してくる誘惑が生まれる。
 */
export async function findOwnedShopLocation(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
): Promise<{ readonly lat: number; readonly lng: number } | null> {
  const rows = await db
    .select({ lat: shops.lat, lng: shops.lng })
    .from(shops)
    .where(and(eq(shops.id, shopId), eq(shops.ownerId, actor.userId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : { lat: row.lat, lng: row.lng };
}
```

`findOwnedShopLocation` のテストも `owner-scope.test.ts` に 3 件足す。

```ts
describe('findOwnedShopLocation', () => {
  it('自分の店の緯度経度を返す', async () => {
    const location = await findOwnedShopLocation(db, alice.actor, alice.shopId);
    expect(location).toEqual({ lat: ALICE_SHOP_LAT, lng: ALICE_SHOP_LNG });
  });

  it('他人の店は null を返す', async () => {
    expect(await findOwnedShopLocation(db, bob.actor, alice.shopId)).toBeNull();
  });

  it('存在しない店も同じく null を返す（他人の店と区別できない）', async () => {
    expect(
      await findOwnedShopLocation(
        db,
        alice.actor,
        toShopId('shp_00000000000000000000000000000000'),
      ),
    ).toBeNull();
  });

  it('geohash は返さない（導出値をクライアントに持たせない）', async () => {
    const location = await findOwnedShopLocation(db, alice.actor, alice.shopId);
    expect(Object.keys(location ?? {})).toEqual(['lat', 'lng']);
  });
});
```

`ALICE_SHOP_LAT` / `ALICE_SHOP_LNG` は `testing/owner-fixtures.ts` が seed に使う座標を export したものである。`seedTwoOwners` の中でリテラルを直接書かず、この 2 定数から入れる。**テストが期待値を自分で決めるのではなく、seed と同じ定義元を読むようにするため。**

- [ ] **Step 5: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/api -- src/repositories/owner-scope.test.ts`
Expected: PASS（14 件）。

- [ ] **Step 6: 越境不能の証明テストと geohash 再計算の回帰テストを書く（失敗する）**

```ts
// apps/api/src/repositories/shop-repository.ownership.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coordinate, encodeGeohash } from '@meshimap/geo';

import { SHOP_GEOHASH_PRECISION } from '../db/constants';
import { createMigratedD1 } from '../db/testing/local-d1';
import type { LocalD1 } from '../db/testing/local-d1';
import { createDatabase } from '../db/client';
import type { Database } from '../db/client';
import { updateShopAsOwner } from './shop-repository';
import { readShopRow, seedTwoOwners } from './testing/owner-fixtures';
import type { OwnerFixture } from './testing/owner-fixtures';

let local: LocalD1;
let db: Database;
let alice: OwnerFixture;
let bob: OwnerFixture;

beforeEach(async () => {
  local = await createMigratedD1();
  db = createDatabase(local.d1);
  const seeded = await seedTwoOwners(local);
  alice = seeded.alice;
  bob = seeded.bob;
});

afterEach(async () => {
  await local.dispose();
});

describe('オーナーは他人の店を編集できない', () => {
  it('他人の店への updateShopAsOwner は null を返し、行を 1 バイトも変えない', async () => {
    const before = await readShopRow(local, alice.shopId);

    const result = await updateShopAsOwner(db, bob.actor, alice.shopId, {
      name: '乗っ取り店',
      latitude: 0,
      longitude: 0,
    });

    expect(result).toBeNull();
    const after = await readShopRow(local, alice.shopId);
    // 戻り値だけ見ていると「書いてから null を返す」実装を見逃す。行全体を比較する
    expect(after).toEqual(before);
  });

  it('他人の店の行数が変わらない（DELETE されていない）', async () => {
    await updateShopAsOwner(db, bob.actor, alice.shopId, { name: '乗っ取り店' });
    const row = await readShopRow(local, alice.shopId);
    expect(row).not.toBeNull();
  });

  it('自分の店なら更新できる（越境ガードが正しい操作まで止めていないことの確認）', async () => {
    const result = await updateShopAsOwner(db, alice.actor, alice.shopId, { name: '新しい屋号' });
    expect(result).not.toBeNull();
    const row = await readShopRow(local, alice.shopId);
    expect(row?.['name']).toBe('新しい屋号');
  });
});

describe('地図のピンを動かすと geohash が振り直される', () => {
  it('緯度経度を更新すると geohash が新しい座標のものに変わる', async () => {
    const before = await readShopRow(local, alice.shopId);
    // 渋谷（35.6595, 139.7005）から浅草（35.7148, 139.7967）へ動かす
    const nextLatitude = 35.7148;
    const nextLongitude = 139.7967;

    await updateShopAsOwner(db, alice.actor, alice.shopId, {
      latitude: nextLatitude,
      longitude: nextLongitude,
    });

    const after = await readShopRow(local, alice.shopId);
    const expected = encodeGeohash(coordinate(nextLatitude, nextLongitude), SHOP_GEOHASH_PRECISION);
    expect(after?.['geohash']).toBe(expected);
    expect(after?.['geohash']).not.toBe(before?.['geohash']);
    expect(after?.['lat']).toBe(nextLatitude);
    expect(after?.['lng']).toBe(nextLongitude);
  });

  it('geohash は必ず 7 文字で、base32 の文字集合に収まる', async () => {
    await updateShopAsOwner(db, alice.actor, alice.shopId, {
      latitude: -33.8688,
      longitude: 151.2093,
    });
    const after = await readShopRow(local, alice.shopId);
    const geohash = after?.['geohash'];
    expect(typeof geohash).toBe('string');
    expect(geohash).toHaveLength(SHOP_GEOHASH_PRECISION);
    expect(geohash).toMatch(/^[0-9bcdefghjkmnpqrstuvwxyz]+$/);
  });

  it('ごく小さな移動（同じ geohash セル内）でも lat / lng は更新される', async () => {
    const before = await readShopRow(local, alice.shopId);
    await updateShopAsOwner(db, alice.actor, alice.shopId, {
      latitude: 35.65951,
      longitude: 139.70051,
    });
    const after = await readShopRow(local, alice.shopId);
    expect(after?.['lat']).toBe(35.65951);
    expect(after?.['geohash']).toBe(before?.['geohash']);
  });

  it('idx_shops_status_geohash で更新後の店を引ける', async () => {
    await updateShopAsOwner(db, alice.actor, alice.shopId, {
      latitude: 35.7148,
      longitude: 139.7967,
    });
    const prefix = encodeGeohash(coordinate(35.7148, 139.7967), SHOP_GEOHASH_PRECISION).slice(0, 5);
    const rows = await local.d1
      .prepare(`SELECT id FROM shops WHERE status = 'published' AND geohash LIKE ? || '%'`)
      .bind(prefix)
      .all<{ id: string }>();
    expect(rows.results.map((row) => row.id)).toContain(alice.shopId);
  });
});
```

- [ ] **Step 7: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/api -- src/repositories/shop-repository.ownership.test.ts`
Expected: Phase 4 の `updateShopAsOwner` が仕様どおり実装されていれば **PASS する可能性がある**。その場合も Step 6 は無駄ではない。これは回帰テストであり、「今は通っている」ことを固定するのが目的である。**もし FAIL したら Phase 4 の実装にバグがある**ので、以下のどれに該当するかを特定してから Phase 4 側を直す。

| 落ちるテスト                                  | 疑うべき実装                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| 「行を 1 バイトも変えない」                   | `WHERE` に `owner_id = ?` が入っていない。SELECT してからアプリ層で判定している |
| 「geohash が新しい座標のものに変わる」        | 緯度経度だけ更新して geohash を更新していない                                   |
| 「geohash は必ず 7 文字」                     | `encodeGeohash` に渡す precision が `SHOP_GEOHASH_PRECISION` でない             |
| 「ごく小さな移動でも lat / lng は更新される」 | geohash が同じなら UPDATE をスキップする最適化が入っている                      |

- [ ] **Step 8: 必要なら Phase 4 の実装を直し、テストを通す**

Run: `npm run test -w @meshimap/api -- src/repositories/`
Expected: PASS。

- [ ] **Step 9: わざと壊して検証が効いていることを確認する**

`findOwnedShopId` の `where` から所有権条件を一時的に外す。

```ts
// 一時的な改悪
.where(eq(shops.id, shopId))
```

Run: `npm run test -w @meshimap/api -- src/repositories/owner-scope.test.ts`
Expected: FAIL。「他人の店なら null を返す」が `expected 'shp_bob' to be null`、「owner_id が NULL の店（オーナー未割当）は誰のものでもない」が `expected 'shp_orphan' to be null` で落ちる。

次に `updateShopAsOwner` の `WHERE` から `owner_id` 条件を外す。
Expected: FAIL。「他人の店への updateShopAsOwner は null を返し、行を 1 バイトも変えない」が、`name` と `updated_at` の差分を示して落ちる。**これが Phase 8 で一番重要なテストである。**

**両方確認したら元に戻し、再度テストが緑になることを確認する。**

- [ ] **Step 10: ミューテーションテストを実行する**

Run: `npm run test:mutation -w @meshimap/api`
Expected: スコア 85 以上。`row === undefined` → `row !== undefined` の変異は「自分の店なら shopId を返す」と「他人の店なら null を返す」の両方が同時に殺す。`.limit(1)` の変異は出力を変えないので生き残る可能性がある。その場合は**発行クエリ数ではなく結果件数を固定する**テスト（同じオーナーが 2 店舗持つ状況で `findOwnedShopId` が特定の 1 件を返す）を足して殺す。**Stryker の除外設定は追加しない。**

- [ ] **Step 11: コミット**

```bash
git add apps/api/src/repositories/owner-scope.ts apps/api/src/repositories/owner-scope.test.ts \
  apps/api/src/repositories/testing/owner-fixtures.ts \
  apps/api/src/repositories/shop-repository.ownership.test.ts
git commit -m "feat(api): 所有権を SQL で解決する owner-scope と越境不能の証明テストを追加"
```

---

## Task 8-5: 営業時間・臨時休業リポジトリ

**Files:**

- Create: `apps/api/src/repositories/owner-hours-repository.ts`
- Test: `apps/api/src/repositories/owner-hours-repository.test.ts`

**Interfaces:**

- Consumes: `findOwnedShopId`（Task 8-4）、`seedTwoOwners`（Task 8-4）、`shopHoursInputSchema` / `ShopHoursInput` / `shopClosureCreateSchema`（Task 8-3）、`shopHours` / `shopClosures`（既存スキーマ）、`Database`、`OwnerActor`
- Produces:
  - `type ShopHourRow = typeof shopHours.$inferSelect`
  - `type ShopClosureRow = typeof shopClosures.$inferSelect`
  - `async function listShopHoursAsOwner(db, actor, shopId): Promise<{ readonly hours: readonly ShopHourRow[]; readonly closures: readonly ShopClosureRow[] } | null>`
  - `async function replaceShopHoursAsOwner(db, actor, shopId, input: ShopHoursInput, generateId: () => string): Promise<readonly ShopHourRow[] | null>`
  - `async function addShopClosureAsOwner(db, actor, shopId, closureId: string, input: { closedOn: string; reason: string | null }): Promise<ShopClosureRow | null>`
  - `async function deleteShopClosureAsOwner(db, actor, shopId, closureId: string): Promise<boolean>`

### なぜ「全消し→全入れ」なのか

営業時間は「曜日ごとに 0〜2 行」という可変長の集合で、しかも `shop_hours` は `(shop_id, day_of_week)` にユニーク制約を**意図的に付けていない**（中休みのある店が 1 曜日 2 行になるため）。差分更新をしようとすると「どの行が編集でどの行が新規か」をクライアントが管理することになり、ID の漏洩と不整合の温床になる。曜日は 7 個しかないので、全消し → 全入れの方が単純で安全である。D1 は対話型トランザクションを持たないので、DELETE と INSERT は `db.batch()` で 1 往復にまとめて原子性を確保する（`drizzle-orm/d1` の `batch()` は `node_modules/drizzle-orm/d1/driver.d.ts:9` で確認済み）。

### なぜ ID 生成関数を注入するのか

`replaceShopHoursAsOwner` は行数が可変なので、呼び出し側が ID を全部作って渡すのは煩雑になる。`generateId: () => string` を注入すれば、テストでは決定的な連番を返すスタブを渡せて、本番では `crypto.randomUUID()` ベースの生成関数を渡せる。リポジトリの中で直接 `crypto.randomUUID()` を呼ぶと、テストが ID を予測できなくなる。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// apps/api/src/repositories/owner-hours-repository.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMigratedD1 } from '../db/testing/local-d1';
import type { LocalD1 } from '../db/testing/local-d1';
import { createDatabase } from '../db/client';
import type { Database } from '../db/client';
import { seedTwoOwners } from './testing/owner-fixtures';
import type { OwnerFixture } from './testing/owner-fixtures';
import {
  addShopClosureAsOwner,
  deleteShopClosureAsOwner,
  listShopHoursAsOwner,
  replaceShopHoursAsOwner,
} from './owner-hours-repository';

let local: LocalD1;
let db: Database;
let alice: OwnerFixture;
let bob: OwnerFixture;

/** テスト内で ID を予測できるようにする決定的な生成関数 */
function sequentialIds(prefix: string): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}_${counter}`;
  };
}

beforeEach(async () => {
  local = await createMigratedD1();
  db = createDatabase(local.d1);
  const seeded = await seedTwoOwners(local);
  alice = seeded.alice;
  bob = seeded.bob;
});

afterEach(async () => {
  await local.dispose();
});

describe('replaceShopHoursAsOwner', () => {
  it('7 曜日ぶんを一度に保存できる', async () => {
    const entries = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      dayOfWeek,
      openMinute: 660,
      closeMinute: 1320,
      isClosed: false,
    }));
    const saved = await replaceShopHoursAsOwner(
      db,
      alice.actor,
      alice.shopId,
      { entries },
      sequentialIds('sh'),
    );
    expect(saved).toHaveLength(7);
  });

  it('同じ曜日に 2 行（中休み）を保存できる', async () => {
    const saved = await replaceShopHoursAsOwner(
      db,
      alice.actor,
      alice.shopId,
      {
        entries: [
          { dayOfWeek: 1, openMinute: 660, closeMinute: 840, isClosed: false },
          { dayOfWeek: 1, openMinute: 1020, closeMinute: 1320, isClosed: false },
        ],
      },
      sequentialIds('sh'),
    );
    expect(saved?.map((row) => row.openMinute)).toEqual([660, 1020]);
  });

  it('2 回目の保存で 1 回目の行が残らない（全置換）', async () => {
    await replaceShopHoursAsOwner(
      db,
      alice.actor,
      alice.shopId,
      { entries: [{ dayOfWeek: 1, openMinute: 660, closeMinute: 840, isClosed: false }] },
      sequentialIds('first'),
    );
    await replaceShopHoursAsOwner(
      db,
      alice.actor,
      alice.shopId,
      { entries: [{ dayOfWeek: 2, openMinute: 700, closeMinute: 900, isClosed: false }] },
      sequentialIds('second'),
    );
    const listed = await listShopHoursAsOwner(db, alice.actor, alice.shopId);
    expect(listed?.hours.map((row) => row.dayOfWeek)).toEqual([2]);
  });

  it('空配列を渡すと全削除になる', async () => {
    await replaceShopHoursAsOwner(
      db,
      alice.actor,
      alice.shopId,
      { entries: [{ dayOfWeek: 1, openMinute: 660, closeMinute: 840, isClosed: false }] },
      sequentialIds('sh'),
    );
    const saved = await replaceShopHoursAsOwner(
      db,
      alice.actor,
      alice.shopId,
      { entries: [] },
      sequentialIds('x'),
    );
    expect(saved).toEqual([]);
    const listed = await listShopHoursAsOwner(db, alice.actor, alice.shopId);
    expect(listed?.hours).toEqual([]);
  });

  it('日跨ぎ営業（閉店 1560 分 = 翌 02:00）を保存できる', async () => {
    const saved = await replaceShopHoursAsOwner(
      db,
      alice.actor,
      alice.shopId,
      { entries: [{ dayOfWeek: 5, openMinute: 1320, closeMinute: 1560, isClosed: false }] },
      sequentialIds('sh'),
    );
    expect(saved?.[0]?.closeMinute).toBe(1560);
  });

  it('休業日は開店・閉店が null で保存される', async () => {
    const saved = await replaceShopHoursAsOwner(
      db,
      alice.actor,
      alice.shopId,
      { entries: [{ dayOfWeek: 3, openMinute: null, closeMinute: null, isClosed: true }] },
      sequentialIds('sh'),
    );
    expect(saved?.[0]).toMatchObject({
      dayOfWeek: 3,
      openMinute: null,
      closeMinute: null,
      isClosed: true,
    });
  });

  it('他人の店には保存できず、その店の営業時間は空のまま', async () => {
    const result = await replaceShopHoursAsOwner(
      db,
      bob.actor,
      alice.shopId,
      { entries: [{ dayOfWeek: 1, openMinute: 660, closeMinute: 840, isClosed: false }] },
      sequentialIds('sh'),
    );
    expect(result).toBeNull();
    const rows = await local.d1
      .prepare(`SELECT COUNT(*) AS total FROM shop_hours WHERE shop_id = ?`)
      .bind(alice.shopId)
      .first<{ total: number }>();
    expect(rows?.total).toBe(0);
  });

  it('他人の店への保存が、自分の店の営業時間を消してしまわない', async () => {
    await replaceShopHoursAsOwner(
      db,
      bob.actor,
      bob.shopId,
      { entries: [{ dayOfWeek: 1, openMinute: 660, closeMinute: 840, isClosed: false }] },
      sequentialIds('bob'),
    );
    await replaceShopHoursAsOwner(
      db,
      bob.actor,
      alice.shopId,
      { entries: [] },
      sequentialIds('cross'),
    );
    const listed = await listShopHoursAsOwner(db, bob.actor, bob.shopId);
    expect(listed?.hours).toHaveLength(1);
  });
});

describe('addShopClosureAsOwner / deleteShopClosureAsOwner', () => {
  it('臨時休業を追加できる', async () => {
    const created = await addShopClosureAsOwner(db, alice.actor, alice.shopId, 'clo_1', {
      closedOn: '2026-12-31',
      reason: '年末休業',
    });
    expect(created).toMatchObject({ closedOn: '2026-12-31', reason: '年末休業' });
  });

  it('理由なし（null）でも追加できる', async () => {
    const created = await addShopClosureAsOwner(db, alice.actor, alice.shopId, 'clo_2', {
      closedOn: '2026-12-30',
      reason: null,
    });
    expect(created?.reason).toBeNull();
  });

  it('同じ日を 2 回追加すると 2 回目は null を返す（uq_shop_closures_shop_date）', async () => {
    await addShopClosureAsOwner(db, alice.actor, alice.shopId, 'clo_3', {
      closedOn: '2026-12-29',
      reason: null,
    });
    const second = await addShopClosureAsOwner(db, alice.actor, alice.shopId, 'clo_4', {
      closedOn: '2026-12-29',
      reason: null,
    });
    expect(second).toBeNull();
  });

  it('他人の店には臨時休業を追加できない', async () => {
    const result = await addShopClosureAsOwner(db, bob.actor, alice.shopId, 'clo_5', {
      closedOn: '2026-12-28',
      reason: null,
    });
    expect(result).toBeNull();
    const row = await local.d1
      .prepare(`SELECT id FROM shop_closures WHERE id = 'clo_5'`)
      .first<{ id: string }>();
    expect(row).toBeNull();
  });

  it('自分の店の臨時休業を削除できる', async () => {
    await addShopClosureAsOwner(db, alice.actor, alice.shopId, 'clo_6', {
      closedOn: '2026-12-27',
      reason: null,
    });
    expect(await deleteShopClosureAsOwner(db, alice.actor, alice.shopId, 'clo_6')).toBe(true);
    const listed = await listShopHoursAsOwner(db, alice.actor, alice.shopId);
    expect(listed?.closures).toEqual([]);
  });

  it('他人の店の臨時休業は削除できず、行が残る', async () => {
    await addShopClosureAsOwner(db, alice.actor, alice.shopId, 'clo_7', {
      closedOn: '2026-12-26',
      reason: null,
    });
    expect(await deleteShopClosureAsOwner(db, bob.actor, alice.shopId, 'clo_7')).toBe(false);
    const row = await local.d1
      .prepare(`SELECT id FROM shop_closures WHERE id = 'clo_7'`)
      .first<{ id: string }>();
    expect(row?.id).toBe('clo_7');
  });

  it('shopId は自分のものでも、別の店の closureId は削除できない', async () => {
    await addShopClosureAsOwner(db, bob.actor, bob.shopId, 'clo_bob', {
      closedOn: '2026-12-25',
      reason: null,
    });
    expect(await deleteShopClosureAsOwner(db, alice.actor, alice.shopId, 'clo_bob')).toBe(false);
    const row = await local.d1.prepare(`SELECT id FROM shop_closures WHERE id = 'clo_bob'`).first();
    expect(row).not.toBeNull();
  });

  it('存在しない closureId の削除は false を返す', async () => {
    expect(await deleteShopClosureAsOwner(db, alice.actor, alice.shopId, 'clo_nowhere')).toBe(
      false,
    );
  });
});

describe('listShopHoursAsOwner', () => {
  it('他人の店なら null を返す', async () => {
    expect(await listShopHoursAsOwner(db, bob.actor, alice.shopId)).toBeNull();
  });

  it('自分の店で未設定なら空配列 2 本を返す（null ではない）', async () => {
    expect(await listShopHoursAsOwner(db, alice.actor, alice.shopId)).toEqual({
      hours: [],
      closures: [],
    });
  });

  it('営業時間は曜日順・開店時刻順に並ぶ', async () => {
    await replaceShopHoursAsOwner(
      db,
      alice.actor,
      alice.shopId,
      {
        entries: [
          { dayOfWeek: 2, openMinute: 660, closeMinute: 840, isClosed: false },
          { dayOfWeek: 1, openMinute: 1020, closeMinute: 1320, isClosed: false },
          { dayOfWeek: 1, openMinute: 660, closeMinute: 840, isClosed: false },
        ],
      },
      sequentialIds('sh'),
    );
    const listed = await listShopHoursAsOwner(db, alice.actor, alice.shopId);
    expect(listed?.hours.map((row) => [row.dayOfWeek, row.openMinute])).toEqual([
      [1, 660],
      [1, 1020],
      [2, 660],
    ]);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/api -- src/repositories/owner-hours-repository.test.ts`
Expected: FAIL。`Failed to resolve import "./owner-hours-repository"` で全 19 件が落ちる。

- [ ] **Step 3: リポジトリを実装する**

```ts
// apps/api/src/repositories/owner-hours-repository.ts
// 営業時間は「曜日ごとに 0〜2 行」の可変長集合。差分更新は不整合の温床なので全置換する。
// D1 に対話型トランザクションが無いため、DELETE と INSERT は batch() で 1 往復にまとめる。
import { and, asc, eq } from 'drizzle-orm';
import type { ShopId } from '@meshimap/core';
import type { ShopHoursInput } from '@meshimap/core';

import type { OwnerActor } from '../auth/actor';
import type { Database } from '../db/client';
import { shopClosures, shopHours } from '../db/schema';
import { findOwnedShopId } from './owner-scope';

export type ShopHourRow = typeof shopHours.$inferSelect;
export type ShopClosureRow = typeof shopClosures.$inferSelect;

/** SQLite の UNIQUE 違反はドライバから文字列で返る。ここでしか判定しない */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}

async function selectHours(db: Database, shopId: ShopId): Promise<readonly ShopHourRow[]> {
  return await db
    .select()
    .from(shopHours)
    .where(eq(shopHours.shopId, shopId))
    .orderBy(asc(shopHours.dayOfWeek), asc(shopHours.openMinute));
}

export async function listShopHoursAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
): Promise<{
  readonly hours: readonly ShopHourRow[];
  readonly closures: readonly ShopClosureRow[];
} | null> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  if (ownedShopId === null) {
    return null;
  }
  const hours = await selectHours(db, ownedShopId);
  const closures = await db
    .select()
    .from(shopClosures)
    .where(eq(shopClosures.shopId, ownedShopId))
    .orderBy(asc(shopClosures.closedOn));
  return { hours, closures };
}

export async function replaceShopHoursAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
  input: ShopHoursInput,
  generateId: () => string,
): Promise<readonly ShopHourRow[] | null> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  if (ownedShopId === null) {
    return null;
  }
  const deleteStatement = db.delete(shopHours).where(eq(shopHours.shopId, ownedShopId));
  const rows = input.entries.map((entry) => ({
    id: generateId(),
    shopId: ownedShopId,
    dayOfWeek: entry.dayOfWeek,
    openMinute: entry.openMinute,
    closeMinute: entry.closeMinute,
    isClosed: entry.isClosed,
  }));
  if (rows.length === 0) {
    await deleteStatement;
    return [];
  }
  // batch は空配列を受け付けないので、INSERT がある場合だけ 2 文を束ねる
  await db.batch([deleteStatement, db.insert(shopHours).values(rows)]);
  return await selectHours(db, ownedShopId);
}

export async function addShopClosureAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
  closureId: string,
  input: { readonly closedOn: string; readonly reason: string | null },
): Promise<ShopClosureRow | null> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  if (ownedShopId === null) {
    return null;
  }
  try {
    const inserted = await db
      .insert(shopClosures)
      .values({
        id: closureId,
        shopId: ownedShopId,
        closedOn: input.closedOn,
        reason: input.reason,
      })
      .returning();
    return inserted[0] ?? null;
  } catch (error) {
    // 同じ日の重複は「既にある」なので例外ではなく null で返し、ルート層が 409 に変換する
    if (isUniqueViolation(error)) {
      return null;
    }
    throw error;
  }
}

export async function deleteShopClosureAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
  closureId: string,
): Promise<boolean> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  if (ownedShopId === null) {
    return false;
  }
  // shop_id を条件に残すことで、自分の店の ID を使って他店の休業日を消す経路を塞ぐ
  const deleted = await db
    .delete(shopClosures)
    .where(and(eq(shopClosures.id, closureId), eq(shopClosures.shopId, ownedShopId)))
    .returning({ id: shopClosures.id });
  return deleted.length > 0;
}
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/api -- src/repositories/owner-hours-repository.test.ts`
Expected: PASS（19 件）。

- [ ] **Step 5: わざと壊して検証が効いていることを確認する**

`deleteShopClosureAsOwner` の `where` から `eq(shopClosures.shopId, ownedShopId)` を一時的に外す。

Run: `npm run test -w @meshimap/api -- src/repositories/owner-hours-repository.test.ts`
Expected: FAIL。「shopId は自分のものでも、別の店の closureId は削除できない」が `expected false to be true`（実際は削除に成功してしまう）で落ちる。所有する店舗の ID を鍵にして他店のデータを消す、という見落としやすい越境経路が塞がっていることが実証される。

次に `replaceShopHoursAsOwner` の `db.batch([...])` を `await db.insert(...)` だけに変える（DELETE を落とす）。
Expected: FAIL。「2 回目の保存で 1 回目の行が残らない（全置換）」が `expected [1, 2] to equal [2]` で落ちる。

**両方確認したら元に戻し、再度テストが緑になることを確認する。**

- [ ] **Step 6: コミット**

```bash
git add apps/api/src/repositories/owner-hours-repository.ts apps/api/src/repositories/owner-hours-repository.test.ts
git commit -m "feat(api): 営業時間の全置換と臨時休業のリポジトリを追加"
```

---

## Task 8-6: 写真リポジトリと R2 アップロード

**Files:**

- Create: `apps/api/src/repositories/owner-photo-repository.ts`
- Test: `apps/api/src/repositories/owner-photo-repository.test.ts`

**Interfaces:**

- Consumes: `findOwnedShopId`（8-4）、`detectMediaType` / `buildShopPhotoKey` / `putMediaObject` / `deleteMediaObject`（8-2）、`UPLOAD_MAX_BYTES` / `UPLOADABLE_IMAGE_MIME_TYPES`（8-2）、`shopPhotos`（既存スキーマ）、`seedTwoOwners`（8-4）、`local.mediaBucket`（8-2）
- Produces:
  - `type ShopPhotoRow = typeof shopPhotos.$inferSelect`
  - `type PhotoUploadRejection = 'too-large' | 'unsupported-type'`
  - `type PhotoUploadResult = { readonly ok: true; readonly photo: ShopPhotoRow } | { readonly ok: false; readonly reason: PhotoUploadRejection }`
  - `async function listShopPhotosAsOwner(db, actor, shopId): Promise<readonly ShopPhotoRow[] | null>`
  - `async function uploadShopPhotoAsOwner(db, bucket, actor, shopId, photoId, uuid, body: ArrayBuffer): Promise<PhotoUploadResult | null>`
  - `async function updateShopPhotoAsOwner(db, actor, shopId, photoId, input: { caption: string | null; isCover: boolean }): Promise<ShopPhotoRow | null>`
  - `async function reorderShopPhotosAsOwner(db, actor, shopId, photoIds: readonly string[]): Promise<readonly ShopPhotoRow[] | null>`
  - `async function deleteShopPhotoAsOwner(db, bucket, actor, shopId, photoId): Promise<boolean>`

### カバー写真の一意性をどう守るか

`shop_photos` には部分ユニーク索引 `uq_shop_photos_cover`（`ON shop_id WHERE is_cover`）がある。新しい写真をカバーにするには、先に既存のカバーを降ろさなければならない。D1 に対話型トランザクションが無いので、この 2 文は `db.batch()` で束ねる。順序は「全解除 → 指定を設定」。逆順にすると一瞬カバーが 2 枚になり、部分ユニーク索引に弾かれる。

### 削除順序

`deleteShopPhotoAsOwner` は **D1 の行を先に消し、その後 R2 のオブジェクトを消す**。逆順（R2 を先）にすると、R2 削除成功・D1 削除失敗のときに「参照先の無い写真行」が残り、アプリが壊れた画像を表示する。D1 を先にすれば、最悪でも「誰も参照しない R2 オブジェクト」が残るだけで、表示は壊れない。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// apps/api/src/repositories/owner-photo-repository.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UPLOAD_MAX_BYTES } from '@meshimap/core';

import { createMigratedD1 } from '../db/testing/local-d1';
import type { LocalD1 } from '../db/testing/local-d1';
import { createDatabase } from '../db/client';
import type { Database } from '../db/client';
import { seedTwoOwners } from './testing/owner-fixtures';
import type { OwnerFixture } from './testing/owner-fixtures';
import {
  deleteShopPhotoAsOwner,
  listShopPhotosAsOwner,
  reorderShopPhotosAsOwner,
  updateShopPhotoAsOwner,
  uploadShopPhotoAsOwner,
} from './owner-photo-repository';

let local: LocalD1;
let db: Database;
let alice: OwnerFixture;
let bob: OwnerFixture;

/** 有効な PNG の先頭 8 バイト + 任意の長さのダミー本体 */
function pngBytes(totalLength: number): ArrayBuffer {
  const bytes = new Uint8Array(totalLength);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes.buffer;
}

beforeEach(async () => {
  local = await createMigratedD1();
  db = createDatabase(local.d1);
  const seeded = await seedTwoOwners(local);
  alice = seeded.alice;
  bob = seeded.bob;
});

afterEach(async () => {
  await local.dispose();
});

describe('uploadShopPhotoAsOwner', () => {
  it('PNG をアップロードすると R2 に置かれ、D1 に行ができる', async () => {
    const result = await uploadShopPhotoAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      alice.shopId,
      'pht_1',
      'aaaa1111',
      pngBytes(64),
    );
    expect(result).toEqual({ ok: true, photo: expect.objectContaining({ id: 'pht_1' }) });
    const stored = await local.mediaBucket.get('shop-photos/shp_alice/aaaa1111.png');
    expect(stored).not.toBeNull();
  });

  it('保存された R2 キーが <種別>/<id>/<uuid>.<ext> の形になっている', async () => {
    const result = await uploadShopPhotoAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      alice.shopId,
      'pht_2',
      'bbbb2222',
      pngBytes(64),
    );
    expect(result?.ok === true && result.photo.r2Key).toBe('shop-photos/shp_alice/bbbb2222.png');
  });

  it('最初の 1 枚は自動でカバーになる', async () => {
    const result = await uploadShopPhotoAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      alice.shopId,
      'pht_3',
      'cccc3333',
      pngBytes(64),
    );
    expect(result?.ok === true && result.photo.isCover).toBe(true);
  });

  it('2 枚目は自動でカバーにならない', async () => {
    await uploadShopPhotoAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      alice.shopId,
      'pht_4',
      'dddd4444',
      pngBytes(64),
    );
    const second = await uploadShopPhotoAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      alice.shopId,
      'pht_5',
      'eeee5555',
      pngBytes(64),
    );
    expect(second?.ok === true && second.photo.isCover).toBe(false);
  });

  it('sortOrder は追加順に 0, 1, 2 と振られる', async () => {
    await uploadShopPhotoAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      alice.shopId,
      'pht_6',
      'f6',
      pngBytes(64),
    );
    await uploadShopPhotoAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      alice.shopId,
      'pht_7',
      'f7',
      pngBytes(64),
    );
    await uploadShopPhotoAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      alice.shopId,
      'pht_8',
      'f8',
      pngBytes(64),
    );
    const listed = await listShopPhotosAsOwner(db, alice.actor, alice.shopId);
    expect(listed?.map((row) => row.sortOrder)).toEqual([0, 1, 2]);
  });

  it('上限ちょうどのサイズは受け付ける', async () => {
    const result = await uploadShopPhotoAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      alice.shopId,
      'pht_9',
      'g9',
      pngBytes(UPLOAD_MAX_BYTES),
    );
    expect(result?.ok).toBe(true);
  });

  it('上限を 1 バイト超えたら too-large で拒否し、R2 に何も置かない', async () => {
    const result = await uploadShopPhotoAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      alice.shopId,
      'pht_10',
      'h10',
      pngBytes(UPLOAD_MAX_BYTES + 1),
    );
    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(await local.mediaBucket.get('shop-photos/shp_alice/h10.png')).toBeNull();
  });

  it('画像でないバイト列は unsupported-type で拒否し、R2 に何も置かない', async () => {
    // MZ ヘッダ（Windows 実行ファイル）
    const executable = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]).buffer;
    const result = await uploadShopPhotoAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      alice.shopId,
      'pht_11',
      'i11',
      executable,
    );
    expect(result).toEqual({ ok: false, reason: 'unsupported-type' });
    expect(await local.mediaBucket.get('shop-photos/shp_alice/i11.exe')).toBeNull();
    expect(await local.mediaBucket.get('shop-photos/shp_alice/i11.png')).toBeNull();
  });

  it('PDF は画像として受け付けない（店舗写真は画像のみ）', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]).buffer;
    const result = await uploadShopPhotoAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      alice.shopId,
      'pht_12',
      'j12',
      pdf,
    );
    expect(result).toEqual({ ok: false, reason: 'unsupported-type' });
  });

  it('他人の店には null を返し、R2 にも D1 にも何も残さない', async () => {
    const result = await uploadShopPhotoAsOwner(
      db,
      local.mediaBucket,
      bob.actor,
      alice.shopId,
      'pht_13',
      'k13',
      pngBytes(64),
    );
    expect(result).toBeNull();
    expect(await local.mediaBucket.get('shop-photos/shp_alice/k13.png')).toBeNull();
    const row = await local.d1.prepare(`SELECT id FROM shop_photos WHERE id = 'pht_13'`).first();
    expect(row).toBeNull();
  });
});

describe('updateShopPhotoAsOwner（カバー切り替え）', () => {
  beforeEach(async () => {
    await uploadShopPhotoAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      alice.shopId,
      'pht_a',
      'ua',
      pngBytes(64),
    );
    await uploadShopPhotoAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      alice.shopId,
      'pht_b',
      'ub',
      pngBytes(64),
    );
  });

  it('2 枚目をカバーにすると 1 枚目のカバーが外れる', async () => {
    await updateShopPhotoAsOwner(db, alice.actor, alice.shopId, 'pht_b', {
      caption: null,
      isCover: true,
    });
    const listed = await listShopPhotosAsOwner(db, alice.actor, alice.shopId);
    expect(listed?.map((row) => [row.id, row.isCover])).toEqual([
      ['pht_a', false],
      ['pht_b', true],
    ]);
  });

  it('カバーは常に 1 枚以下である（部分ユニーク索引が守られている）', async () => {
    await updateShopPhotoAsOwner(db, alice.actor, alice.shopId, 'pht_b', {
      caption: null,
      isCover: true,
    });
    await updateShopPhotoAsOwner(db, alice.actor, alice.shopId, 'pht_a', {
      caption: null,
      isCover: true,
    });
    const row = await local.d1
      .prepare(`SELECT COUNT(*) AS total FROM shop_photos WHERE shop_id = ? AND is_cover = 1`)
      .bind(alice.shopId)
      .first<{ total: number }>();
    expect(row?.total).toBe(1);
  });

  it('キャプションだけ更新してもカバー状態は変わらない', async () => {
    const updated = await updateShopPhotoAsOwner(db, alice.actor, alice.shopId, 'pht_a', {
      caption: '店内の様子',
      isCover: true,
    });
    expect(updated).toMatchObject({ caption: '店内の様子', isCover: true });
  });

  it('他人の店の写真は更新できない', async () => {
    expect(
      await updateShopPhotoAsOwner(db, bob.actor, alice.shopId, 'pht_a', {
        caption: '改竄',
        isCover: false,
      }),
    ).toBeNull();
    const row = await local.d1
      .prepare(`SELECT caption FROM shop_photos WHERE id = 'pht_a'`)
      .first<{ caption: string | null }>();
    expect(row?.caption).toBeNull();
  });
});

describe('reorderShopPhotosAsOwner', () => {
  beforeEach(async () => {
    await uploadShopPhotoAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      alice.shopId,
      'pht_x',
      'vx',
      pngBytes(64),
    );
    await uploadShopPhotoAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      alice.shopId,
      'pht_y',
      'vy',
      pngBytes(64),
    );
    await uploadShopPhotoAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      alice.shopId,
      'pht_z',
      'vz',
      pngBytes(64),
    );
  });

  it('渡した順に sortOrder が振り直される', async () => {
    const reordered = await reorderShopPhotosAsOwner(db, alice.actor, alice.shopId, [
      'pht_z',
      'pht_x',
      'pht_y',
    ]);
    expect(reordered?.map((row) => row.id)).toEqual(['pht_z', 'pht_x', 'pht_y']);
    expect(reordered?.map((row) => row.sortOrder)).toEqual([0, 1, 2]);
  });

  it('自分の店に属さない ID が混ざっていたら何も変更せず null を返す', async () => {
    await uploadShopPhotoAsOwner(
      db,
      local.mediaBucket,
      bob.actor,
      bob.shopId,
      'pht_bob',
      'vb',
      pngBytes(64),
    );
    const result = await reorderShopPhotosAsOwner(db, alice.actor, alice.shopId, [
      'pht_x',
      'pht_bob',
    ]);
    expect(result).toBeNull();
    const listed = await listShopPhotosAsOwner(db, alice.actor, alice.shopId);
    expect(listed?.map((row) => row.id)).toEqual(['pht_x', 'pht_y', 'pht_z']);
  });

  it('自分の店の写真を一部しか渡さなかったら null を返す（全件必須）', async () => {
    const result = await reorderShopPhotosAsOwner(db, alice.actor, alice.shopId, [
      'pht_x',
      'pht_y',
    ]);
    expect(result).toBeNull();
  });

  it('他人の店は並べ替えできない', async () => {
    expect(
      await reorderShopPhotosAsOwner(db, bob.actor, alice.shopId, ['pht_x', 'pht_y', 'pht_z']),
    ).toBeNull();
  });
});

describe('deleteShopPhotoAsOwner', () => {
  it('D1 の行と R2 のオブジェクトの両方が消える', async () => {
    await uploadShopPhotoAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      alice.shopId,
      'pht_d',
      'wd',
      pngBytes(64),
    );
    expect(
      await deleteShopPhotoAsOwner(db, local.mediaBucket, alice.actor, alice.shopId, 'pht_d'),
    ).toBe(true);
    expect(await local.mediaBucket.get('shop-photos/shp_alice/wd.png')).toBeNull();
    const row = await local.d1.prepare(`SELECT id FROM shop_photos WHERE id = 'pht_d'`).first();
    expect(row).toBeNull();
  });

  it('他人の店の写真は削除できず、R2 のオブジェクトも残る', async () => {
    await uploadShopPhotoAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      alice.shopId,
      'pht_e',
      'we',
      pngBytes(64),
    );
    expect(
      await deleteShopPhotoAsOwner(db, local.mediaBucket, bob.actor, alice.shopId, 'pht_e'),
    ).toBe(false);
    expect(await local.mediaBucket.get('shop-photos/shp_alice/we.png')).not.toBeNull();
  });

  it('存在しない写真の削除は false を返す', async () => {
    expect(
      await deleteShopPhotoAsOwner(db, local.mediaBucket, alice.actor, alice.shopId, 'pht_nowhere'),
    ).toBe(false);
  });
});

describe('listShopPhotosAsOwner', () => {
  it('他人の店なら null を返す', async () => {
    expect(await listShopPhotosAsOwner(db, bob.actor, alice.shopId)).toBeNull();
  });

  it('自分の店で 0 枚なら空配列を返す', async () => {
    expect(await listShopPhotosAsOwner(db, alice.actor, alice.shopId)).toEqual([]);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/api -- src/repositories/owner-photo-repository.test.ts`
Expected: FAIL。`Failed to resolve import "./owner-photo-repository"` で全 23 件が落ちる。

- [ ] **Step 3: リポジトリを実装する**

```ts
// apps/api/src/repositories/owner-photo-repository.ts
// R2 への書き込みと D1 への書き込みを 1 本の流れに閉じ込める。
// 先に検証 → R2 put → D1 insert の順。検証が通らなければ R2 に何も置かない。
import { and, asc, eq, inArray } from 'drizzle-orm';
import { UPLOAD_MAX_BYTES, UPLOADABLE_IMAGE_MIME_TYPES } from '@meshimap/core';
import type { ShopId } from '@meshimap/core';

import type { OwnerActor } from '../auth/actor';
import type { Database } from '../db/client';
import { shopPhotos } from '../db/schema';
import {
  buildShopPhotoKey,
  deleteMediaObject,
  detectMediaType,
  putMediaObject,
} from '../lib/media';
import { findOwnedShopId } from './owner-scope';

export type ShopPhotoRow = typeof shopPhotos.$inferSelect;
export type PhotoUploadRejection = 'too-large' | 'unsupported-type';
export type PhotoUploadResult =
  | { readonly ok: true; readonly photo: ShopPhotoRow }
  | { readonly ok: false; readonly reason: PhotoUploadRejection };

async function selectPhotos(db: Database, shopId: ShopId): Promise<readonly ShopPhotoRow[]> {
  return await db
    .select()
    .from(shopPhotos)
    .where(eq(shopPhotos.shopId, shopId))
    .orderBy(asc(shopPhotos.sortOrder));
}

export async function listShopPhotosAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
): Promise<readonly ShopPhotoRow[] | null> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  return ownedShopId === null ? null : await selectPhotos(db, ownedShopId);
}

export async function uploadShopPhotoAsOwner(
  db: Database,
  bucket: R2Bucket,
  actor: OwnerActor,
  shopId: ShopId,
  photoId: string,
  uuid: string,
  body: ArrayBuffer,
): Promise<PhotoUploadResult | null> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  if (ownedShopId === null) {
    return null;
  }
  if (body.byteLength > UPLOAD_MAX_BYTES) {
    return { ok: false, reason: 'too-large' };
  }
  // Content-Type ヘッダは偽装できるので、実バイト列で判定した結果だけを信じる
  const detected = detectMediaType(new Uint8Array(body));
  if (detected === null) {
    return { ok: false, reason: 'unsupported-type' };
  }
  const isUploadableImage = UPLOADABLE_IMAGE_MIME_TYPES.some((mime) => mime === detected.mimeType);
  if (!isUploadableImage) {
    return { ok: false, reason: 'unsupported-type' };
  }
  const existing = await selectPhotos(db, ownedShopId);
  const key = buildShopPhotoKey(ownedShopId, uuid, detected.extension);
  await putMediaObject(bucket, key, body, detected.mimeType);
  const inserted = await db
    .insert(shopPhotos)
    .values({
      id: photoId,
      shopId: ownedShopId,
      r2Key: key,
      caption: null,
      sortOrder: existing.length,
      // 1 枚目は必ずカバーにする。カバー未設定の店が一覧で無地になるのを防ぐ
      isCover: existing.length === 0,
    })
    .returning();
  const photo = inserted[0];
  if (photo === undefined) {
    return { ok: false, reason: 'unsupported-type' };
  }
  return { ok: true, photo };
}

export async function updateShopPhotoAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
  photoId: string,
  input: { readonly caption: string | null; readonly isCover: boolean },
): Promise<ShopPhotoRow | null> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  if (ownedShopId === null) {
    return null;
  }
  const target = and(eq(shopPhotos.id, photoId), eq(shopPhotos.shopId, ownedShopId));
  if (input.isCover) {
    // uq_shop_photos_cover は部分ユニーク索引。全解除を先に走らせないと一瞬 2 枚になって弾かれる
    await db.batch([
      db.update(shopPhotos).set({ isCover: false }).where(eq(shopPhotos.shopId, ownedShopId)),
      db.update(shopPhotos).set({ caption: input.caption, isCover: true }).where(target),
    ]);
  } else {
    await db.update(shopPhotos).set({ caption: input.caption, isCover: false }).where(target);
  }
  const rows = await db.select().from(shopPhotos).where(target).limit(1);
  return rows[0] ?? null;
}

export async function reorderShopPhotosAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
  photoIds: readonly string[],
): Promise<readonly ShopPhotoRow[] | null> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  if (ownedShopId === null) {
    return null;
  }
  const owned = await db
    .select({ id: shopPhotos.id })
    .from(shopPhotos)
    .where(and(eq(shopPhotos.shopId, ownedShopId), inArray(shopPhotos.id, [...photoIds])));
  // 部分的な並べ替えを許すと sort_order に穴や重複ができるので、全件ぴったりを要求する
  const total = await selectPhotos(db, ownedShopId);
  if (owned.length !== photoIds.length || total.length !== photoIds.length) {
    return null;
  }
  await db.batch(
    photoIds.map((photoId, index) =>
      db
        .update(shopPhotos)
        .set({ sortOrder: index })
        .where(and(eq(shopPhotos.id, photoId), eq(shopPhotos.shopId, ownedShopId))),
    ) as unknown as Parameters<Database['batch']>[0],
  );
  return await selectPhotos(db, ownedShopId);
}

export async function deleteShopPhotoAsOwner(
  db: Database,
  bucket: R2Bucket,
  actor: OwnerActor,
  shopId: ShopId,
  photoId: string,
): Promise<boolean> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  if (ownedShopId === null) {
    return false;
  }
  // D1 を先に消す。R2 を先に消すと、R2 成功 / D1 失敗のとき壊れた画像を表示する行が残る
  const deleted = await db
    .delete(shopPhotos)
    .where(and(eq(shopPhotos.id, photoId), eq(shopPhotos.shopId, ownedShopId)))
    .returning({ r2Key: shopPhotos.r2Key });
  const removed = deleted[0];
  if (removed === undefined) {
    return false;
  }
  await deleteMediaObject(bucket, removed.r2Key);
  return true;
}
```

**注意：** `reorderShopPhotosAsOwner` の `db.batch(...)` に付けた `as unknown as` は、`batch()` の引数型が「最低 1 要素のタプル」を要求するのに対し、こちらが可変長配列を渡すためのものである。規約は `as` を禁止しているので、**実装時に `batch()` の型定義を確認し、`readonly [first, ...rest]` に分解して渡す形に書き直すこと**。分解の例：

```ts
const statements = photoIds.map((photoId, index) => /* 上と同じ update */);
const [first, ...rest] = statements;
if (first === undefined) {
  return null; // photoIds.min(1) を Zod で保証しているので実際には到達しないが、型のために書く
}
await db.batch([first, ...rest]);
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/api -- src/repositories/owner-photo-repository.test.ts`
Expected: PASS（23 件）。

- [ ] **Step 5: わざと壊して検証が効いていることを確認する**

`uploadShopPhotoAsOwner` の検証順を入れ替え、`putMediaObject` をサイズ検査の**前**に移動する。

Run: `npm run test -w @meshimap/api -- src/repositories/owner-photo-repository.test.ts`
Expected: FAIL。「上限を 1 バイト超えたら too-large で拒否し、R2 に何も置かない」が `expected null not to be null`（R2 にオブジェクトが残っている）で落ちる。「検証してから書く」という順序が、テストによって固定されていることが実証される。

次に `updateShopPhotoAsOwner` の `db.batch` から全解除の UPDATE を落とす。
Expected: FAIL。「2 枚目をカバーにすると 1 枚目のカバーが外れる」が UNIQUE 制約違反の例外、または「カバーは常に 1 枚以下である」が `expected 2 to be 1` で落ちる。

**両方確認したら元に戻し、再度テストが緑になることを確認する。**

- [ ] **Step 6: コミット**

```bash
git add apps/api/src/repositories/owner-photo-repository.ts apps/api/src/repositories/owner-photo-repository.test.ts
git commit -m "feat(api): 店舗写真の R2 アップロード・カバー指定・並べ替えを追加"
```

---

## Task 8-7: メニューリポジトリ

**Files:**

- Create: `apps/api/src/repositories/owner-menu-repository.ts`
- Test: `apps/api/src/repositories/owner-menu-repository.test.ts`

**Interfaces:**

- Consumes: `findOwnedShopId`（8-4）、`menuCategoryCreateSchema` / `menuItemInputSchema` / `MenuItemInput`（8-3）、`menuCategories` / `menuItems`（既存スキーマ）、`seedTwoOwners`（8-4）
- Produces:
  - `type MenuCategoryRow = typeof menuCategories.$inferSelect`
  - `type MenuItemRow = typeof menuItems.$inferSelect`
  - `type OwnerMenu = { readonly categories: readonly MenuCategoryRow[]; readonly items: readonly MenuItemRow[] }`
  - `async function listMenuAsOwner(db, actor, shopId): Promise<OwnerMenu | null>`
  - `async function createMenuCategoryAsOwner(db, actor, shopId, categoryId: string, input: { name: string; sortOrder: number }): Promise<MenuCategoryRow | null>`
  - `async function deleteMenuCategoryAsOwner(db, actor, shopId, categoryId: string): Promise<boolean>`
  - `async function createMenuItemAsOwner(db, actor, shopId, menuItemId: string, input: MenuItemInput): Promise<MenuItemRow | null>`
  - `async function updateMenuItemAsOwner(db, actor, shopId, menuItemId: string, input: MenuItemInput): Promise<MenuItemRow | null>`
  - `async function deleteMenuItemAsOwner(db, actor, shopId, menuItemId: string): Promise<boolean>`

### 複合外部キーが越境を勝手に塞いでくれる

`menu_items` は `(shop_id, category_id) → menu_categories(shop_id, id)` という複合 FK を持つ（`apps/api/src/db/schema/menu.ts` で確認）。つまり「他店のカテゴリ ID を自分のメニュー項目に付ける」ことは DB が拒否する。アプリ層で `categoryId` の所有者を確認するコードを書く必要が無い。これは「所有権を SQL に埋める」という方針が、スキーマ設計の段階で既に効いている例である。テストではこの防御が実際に働くことを確認する。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// apps/api/src/repositories/owner-menu-repository.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMigratedD1 } from '../db/testing/local-d1';
import type { LocalD1 } from '../db/testing/local-d1';
import { createDatabase } from '../db/client';
import type { Database } from '../db/client';
import { seedTwoOwners } from './testing/owner-fixtures';
import type { OwnerFixture } from './testing/owner-fixtures';
import {
  createMenuCategoryAsOwner,
  createMenuItemAsOwner,
  deleteMenuCategoryAsOwner,
  deleteMenuItemAsOwner,
  listMenuAsOwner,
  updateMenuItemAsOwner,
} from './owner-menu-repository';

let local: LocalD1;
let db: Database;
let alice: OwnerFixture;
let bob: OwnerFixture;

const baseItem = {
  name: '特製ラーメン',
  description: '濃厚豚骨',
  priceYen: 980,
  categoryId: null,
  isRecommended: false,
  sortOrder: 0,
} as const;

beforeEach(async () => {
  local = await createMigratedD1();
  db = createDatabase(local.d1);
  const seeded = await seedTwoOwners(local);
  alice = seeded.alice;
  bob = seeded.bob;
});

afterEach(async () => {
  await local.dispose();
});

describe('createMenuCategoryAsOwner', () => {
  it('自分の店にカテゴリを作れる', async () => {
    const created = await createMenuCategoryAsOwner(db, alice.actor, alice.shopId, 'mct_1', {
      name: '麺類',
      sortOrder: 0,
    });
    expect(created).toMatchObject({ id: 'mct_1', name: '麺類', sortOrder: 0 });
  });

  it('他人の店にはカテゴリを作れず、行も残らない', async () => {
    expect(
      await createMenuCategoryAsOwner(db, bob.actor, alice.shopId, 'mct_x', {
        name: '侵入',
        sortOrder: 0,
      }),
    ).toBeNull();
    const row = await local.d1.prepare(`SELECT id FROM menu_categories WHERE id = 'mct_x'`).first();
    expect(row).toBeNull();
  });
});

describe('createMenuItemAsOwner', () => {
  it('カテゴリ無し（categoryId = null）でメニュー項目を作れる', async () => {
    const created = await createMenuItemAsOwner(db, alice.actor, alice.shopId, 'mni_1', baseItem);
    expect(created).toMatchObject({ id: 'mni_1', priceYen: 980, categoryId: null });
  });

  it('自分の店のカテゴリに紐づけられる', async () => {
    await createMenuCategoryAsOwner(db, alice.actor, alice.shopId, 'mct_a', {
      name: '麺類',
      sortOrder: 0,
    });
    const created = await createMenuItemAsOwner(db, alice.actor, alice.shopId, 'mni_2', {
      ...baseItem,
      categoryId: 'mct_a',
    });
    expect(created?.categoryId).toBe('mct_a');
  });

  it('他人の店のカテゴリ ID を指定すると null を返す（複合外部キーが拒否する）', async () => {
    await createMenuCategoryAsOwner(db, bob.actor, bob.shopId, 'mct_bob', {
      name: '他店',
      sortOrder: 0,
    });
    const created = await createMenuItemAsOwner(db, alice.actor, alice.shopId, 'mni_3', {
      ...baseItem,
      categoryId: 'mct_bob',
    });
    expect(created).toBeNull();
    const row = await local.d1.prepare(`SELECT id FROM menu_items WHERE id = 'mni_3'`).first();
    expect(row).toBeNull();
  });

  it('存在しないカテゴリ ID も null を返す', async () => {
    expect(
      await createMenuItemAsOwner(db, alice.actor, alice.shopId, 'mni_4', {
        ...baseItem,
        categoryId: 'mct_ghost',
      }),
    ).toBeNull();
  });

  it('価格 0 円のメニューを作れる', async () => {
    const created = await createMenuItemAsOwner(db, alice.actor, alice.shopId, 'mni_5', {
      ...baseItem,
      name: 'お通し',
      priceYen: 0,
    });
    expect(created?.priceYen).toBe(0);
  });

  it('おすすめフラグを立てられる', async () => {
    const created = await createMenuItemAsOwner(db, alice.actor, alice.shopId, 'mni_6', {
      ...baseItem,
      isRecommended: true,
    });
    expect(created?.isRecommended).toBe(true);
  });

  it('他人の店にはメニュー項目を作れない', async () => {
    expect(await createMenuItemAsOwner(db, bob.actor, alice.shopId, 'mni_7', baseItem)).toBeNull();
  });
});

describe('updateMenuItemAsOwner', () => {
  beforeEach(async () => {
    await createMenuItemAsOwner(db, alice.actor, alice.shopId, 'mni_u', baseItem);
  });

  it('自分の店のメニュー項目を更新できる', async () => {
    const updated = await updateMenuItemAsOwner(db, alice.actor, alice.shopId, 'mni_u', {
      ...baseItem,
      name: '特製つけ麺',
      priceYen: 1080,
    });
    expect(updated).toMatchObject({ name: '特製つけ麺', priceYen: 1080 });
  });

  it('他人の店のメニュー項目は更新できず、値も変わらない', async () => {
    expect(
      await updateMenuItemAsOwner(db, bob.actor, alice.shopId, 'mni_u', {
        ...baseItem,
        priceYen: 1,
      }),
    ).toBeNull();
    const row = await local.d1
      .prepare(`SELECT price FROM menu_items WHERE id = 'mni_u'`)
      .first<{ price: number }>();
    expect(row?.price).toBe(980);
  });

  it('存在しないメニュー項目の更新は null を返す', async () => {
    expect(
      await updateMenuItemAsOwner(db, alice.actor, alice.shopId, 'mni_ghost', baseItem),
    ).toBeNull();
  });
});

describe('deleteMenuCategoryAsOwner', () => {
  it('カテゴリを消すと、そのカテゴリのメニュー項目も消える（複合 FK の cascade）', async () => {
    await createMenuCategoryAsOwner(db, alice.actor, alice.shopId, 'mct_del', {
      name: '消える',
      sortOrder: 0,
    });
    await createMenuItemAsOwner(db, alice.actor, alice.shopId, 'mni_del', {
      ...baseItem,
      categoryId: 'mct_del',
    });
    expect(await deleteMenuCategoryAsOwner(db, alice.actor, alice.shopId, 'mct_del')).toBe(true);
    const menu = await listMenuAsOwner(db, alice.actor, alice.shopId);
    expect(menu?.categories).toEqual([]);
    expect(menu?.items).toEqual([]);
  });

  it('カテゴリ無しのメニュー項目は、別カテゴリ削除の巻き添えにならない', async () => {
    await createMenuCategoryAsOwner(db, alice.actor, alice.shopId, 'mct_o', {
      name: '他',
      sortOrder: 0,
    });
    await createMenuItemAsOwner(db, alice.actor, alice.shopId, 'mni_free', baseItem);
    await deleteMenuCategoryAsOwner(db, alice.actor, alice.shopId, 'mct_o');
    const menu = await listMenuAsOwner(db, alice.actor, alice.shopId);
    expect(menu?.items.map((row) => row.id)).toEqual(['mni_free']);
  });

  it('他人の店のカテゴリは削除できない', async () => {
    await createMenuCategoryAsOwner(db, alice.actor, alice.shopId, 'mct_keep', {
      name: '残る',
      sortOrder: 0,
    });
    expect(await deleteMenuCategoryAsOwner(db, bob.actor, alice.shopId, 'mct_keep')).toBe(false);
    const row = await local.d1
      .prepare(`SELECT id FROM menu_categories WHERE id = 'mct_keep'`)
      .first();
    expect(row).not.toBeNull();
  });
});

describe('deleteMenuItemAsOwner', () => {
  it('自分の店のメニュー項目を削除できる', async () => {
    await createMenuItemAsOwner(db, alice.actor, alice.shopId, 'mni_d', baseItem);
    expect(await deleteMenuItemAsOwner(db, alice.actor, alice.shopId, 'mni_d')).toBe(true);
  });

  it('他人の店のメニュー項目は削除できず、行が残る', async () => {
    await createMenuItemAsOwner(db, alice.actor, alice.shopId, 'mni_k', baseItem);
    expect(await deleteMenuItemAsOwner(db, bob.actor, alice.shopId, 'mni_k')).toBe(false);
    const row = await local.d1.prepare(`SELECT id FROM menu_items WHERE id = 'mni_k'`).first();
    expect(row).not.toBeNull();
  });
});

describe('listMenuAsOwner', () => {
  it('他人の店なら null を返す', async () => {
    expect(await listMenuAsOwner(db, bob.actor, alice.shopId)).toBeNull();
  });

  it('自分の店で未登録なら空配列 2 本を返す', async () => {
    expect(await listMenuAsOwner(db, alice.actor, alice.shopId)).toEqual({
      categories: [],
      items: [],
    });
  });

  it('カテゴリは sortOrder 順、メニュー項目も sortOrder 順に並ぶ', async () => {
    await createMenuCategoryAsOwner(db, alice.actor, alice.shopId, 'mct_2', {
      name: '二番目',
      sortOrder: 1,
    });
    await createMenuCategoryAsOwner(db, alice.actor, alice.shopId, 'mct_1', {
      name: '一番目',
      sortOrder: 0,
    });
    await createMenuItemAsOwner(db, alice.actor, alice.shopId, 'mni_b', {
      ...baseItem,
      sortOrder: 1,
    });
    await createMenuItemAsOwner(db, alice.actor, alice.shopId, 'mni_a', {
      ...baseItem,
      sortOrder: 0,
    });
    const menu = await listMenuAsOwner(db, alice.actor, alice.shopId);
    expect(menu?.categories.map((row) => row.id)).toEqual(['mct_1', 'mct_2']);
    expect(menu?.items.map((row) => row.id)).toEqual(['mni_a', 'mni_b']);
  });

  it('他店のメニューは混ざらない', async () => {
    await createMenuItemAsOwner(db, bob.actor, bob.shopId, 'mni_bob', baseItem);
    await createMenuItemAsOwner(db, alice.actor, alice.shopId, 'mni_alice', baseItem);
    const menu = await listMenuAsOwner(db, alice.actor, alice.shopId);
    expect(menu?.items.map((row) => row.id)).toEqual(['mni_alice']);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/api -- src/repositories/owner-menu-repository.test.ts`
Expected: FAIL。`Failed to resolve import "./owner-menu-repository"` で全 21 件が落ちる。

- [ ] **Step 3: リポジトリを実装する**

```ts
// apps/api/src/repositories/owner-menu-repository.ts
// (shop_id, category_id) → menu_categories(shop_id, id) の複合外部キーが、
// 「他店のカテゴリに自分のメニューをぶら下げる」経路を DB レベルで塞いでいる。
// したがってアプリ層で categoryId の所有者を確認するコードは書かない。
import { and, asc, eq } from 'drizzle-orm';
import type { MenuItemInput, ShopId } from '@meshimap/core';

import type { OwnerActor } from '../auth/actor';
import type { Database } from '../db/client';
import { menuCategories, menuItems } from '../db/schema';
import { findOwnedShopId } from './owner-scope';

export type MenuCategoryRow = typeof menuCategories.$inferSelect;
export type MenuItemRow = typeof menuItems.$inferSelect;
export type OwnerMenu = {
  readonly categories: readonly MenuCategoryRow[];
  readonly items: readonly MenuItemRow[];
};

function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Error && /FOREIGN KEY constraint failed/.test(error.message);
}

export async function listMenuAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
): Promise<OwnerMenu | null> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  if (ownedShopId === null) {
    return null;
  }
  const categories = await db
    .select()
    .from(menuCategories)
    .where(eq(menuCategories.shopId, ownedShopId))
    .orderBy(asc(menuCategories.sortOrder));
  const items = await db
    .select()
    .from(menuItems)
    .where(eq(menuItems.shopId, ownedShopId))
    .orderBy(asc(menuItems.sortOrder));
  return { categories, items };
}

export async function createMenuCategoryAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
  categoryId: string,
  input: { readonly name: string; readonly sortOrder: number },
): Promise<MenuCategoryRow | null> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  if (ownedShopId === null) {
    return null;
  }
  const inserted = await db
    .insert(menuCategories)
    .values({ id: categoryId, shopId: ownedShopId, name: input.name, sortOrder: input.sortOrder })
    .returning();
  return inserted[0] ?? null;
}

export async function deleteMenuCategoryAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
  categoryId: string,
): Promise<boolean> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  if (ownedShopId === null) {
    return false;
  }
  const deleted = await db
    .delete(menuCategories)
    .where(and(eq(menuCategories.id, categoryId), eq(menuCategories.shopId, ownedShopId)))
    .returning({ id: menuCategories.id });
  return deleted.length > 0;
}

export async function createMenuItemAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
  menuItemId: string,
  input: MenuItemInput,
): Promise<MenuItemRow | null> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  if (ownedShopId === null) {
    return null;
  }
  try {
    const inserted = await db
      .insert(menuItems)
      .values({
        id: menuItemId,
        shopId: ownedShopId,
        categoryId: input.categoryId,
        name: input.name,
        description: input.description,
        price: input.priceYen,
        r2Key: null,
        isRecommended: input.isRecommended,
        sortOrder: input.sortOrder,
      })
      .returning();
    return inserted[0] ?? null;
  } catch (error) {
    // 他店のカテゴリ ID や存在しないカテゴリ ID は複合 FK が拒否する。404 相当として null にする
    if (isForeignKeyViolation(error)) {
      return null;
    }
    throw error;
  }
}

export async function updateMenuItemAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
  menuItemId: string,
  input: MenuItemInput,
): Promise<MenuItemRow | null> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  if (ownedShopId === null) {
    return null;
  }
  try {
    const updated = await db
      .update(menuItems)
      .set({
        categoryId: input.categoryId,
        name: input.name,
        description: input.description,
        price: input.priceYen,
        isRecommended: input.isRecommended,
        sortOrder: input.sortOrder,
      })
      .where(and(eq(menuItems.id, menuItemId), eq(menuItems.shopId, ownedShopId)))
      .returning();
    return updated[0] ?? null;
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      return null;
    }
    throw error;
  }
}

export async function deleteMenuItemAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
  menuItemId: string,
): Promise<boolean> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  if (ownedShopId === null) {
    return false;
  }
  const deleted = await db
    .delete(menuItems)
    .where(and(eq(menuItems.id, menuItemId), eq(menuItems.shopId, ownedShopId)))
    .returning({ id: menuItems.id });
  return deleted.length > 0;
}
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/api -- src/repositories/owner-menu-repository.test.ts`
Expected: PASS（21 件）。

- [ ] **Step 5: わざと壊して検証が効いていることを確認する**

`updateMenuItemAsOwner` の `where` から `eq(menuItems.shopId, ownedShopId)` を一時的に外す。

Run: `npm run test -w @meshimap/api -- src/repositories/owner-menu-repository.test.ts`
Expected: FAIL。「他人の店のメニュー項目は更新できず、値も変わらない」が `expected 1 to be 980` で落ちる。所有権チェックを通過した後でも、対象行の条件に `shop_id` を残す必要があることが実証される（`findOwnedShopId` は「この人は何か店を持っている」ではなく「この shopId を持っている」を確かめるが、メニュー項目 ID 自体は別店のものを指せる）。

次に `createMenuItemAsOwner` の `catch` から `isForeignKeyViolation` の分岐を外し、常に `throw error` にする。
Expected: FAIL。「他人の店のカテゴリ ID を指定すると null を返す（複合外部キーが拒否する）」が、`expected null, but D1_ERROR: FOREIGN KEY constraint failed was thrown` で落ちる。

**両方確認したら元に戻し、再度テストが緑になることを確認する。**

- [ ] **Step 6: コミット**

```bash
git add apps/api/src/repositories/owner-menu-repository.ts apps/api/src/repositories/owner-menu-repository.test.ts
git commit -m "feat(api): メニューカテゴリ・メニュー項目のリポジトリを追加"
```

---

## Task 8-8: 座席設定リポジトリ

**Files:**

- Create: `apps/api/src/repositories/owner-seat-repository.ts`
- Test: `apps/api/src/repositories/owner-seat-repository.test.ts`

**Interfaces:**

- Consumes: `findOwnedShopId`（8-4）、`seatSettingsInputSchema` / `SeatSettingsInput`（8-3）、`seatSettings`（既存スキーマ）、`seedTwoOwners`（8-4）
- Produces:
  - `type SeatSettingsRow = typeof seatSettings.$inferSelect`
  - `const DEFAULT_SEAT_SETTINGS: { capacity: 10; slotMinutes: 90; maxParallel: 1; acceptsReservation: false }`
  - `async function findSeatSettingsAsOwner(db, actor, shopId): Promise<SeatSettingsRow | null>`
  - `async function upsertSeatSettingsAsOwner(db, actor, shopId, input: SeatSettingsInput): Promise<SeatSettingsRow | null>`

### 「行が無い」と「他人の店」を混同しないための設計

`seat_settings` は `shop_id` が主キーで、まだ設定していない店には行が無い。素朴に `SELECT ... WHERE shop_id = ?` を書くと、「未設定」と「他人の店」がどちらも 0 行になり、ルート層が 404 と「既定値を返す」を区別できなくなる。

そこで `findSeatSettingsAsOwner` は **2 段階**にする。

1. `findOwnedShopId` で所有権を確かめる。`null` なら `null`（= 404）。
2. 所有していれば `seat_settings` を引き、行が無ければ `DEFAULT_SEAT_SETTINGS` を組み立てて返す。

これは「アプリ層で権限を `if` で判定している」のではない。所有権の判定は 1 の SQL がすべて行っており、2 は「所有していることが確定した後の、表示用の既定値」を作っているだけである。

`acceptsReservation` の既定値が `false` なのは、スキーマ（`apps/api/src/db/schema/menu.ts`）が `.default(false)` としているからである。予約受付は明示的に有効化するもので、設定を書いた覚えのない店に予約が入る事故を防ぐ。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// apps/api/src/repositories/owner-seat-repository.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMigratedD1 } from '../db/testing/local-d1';
import type { LocalD1 } from '../db/testing/local-d1';
import { createDatabase } from '../db/client';
import type { Database } from '../db/client';
import { seedTwoOwners } from './testing/owner-fixtures';
import type { OwnerFixture } from './testing/owner-fixtures';
import {
  DEFAULT_SEAT_SETTINGS,
  findSeatSettingsAsOwner,
  upsertSeatSettingsAsOwner,
} from './owner-seat-repository';

let local: LocalD1;
let db: Database;
let alice: OwnerFixture;
let bob: OwnerFixture;

beforeEach(async () => {
  local = await createMigratedD1();
  db = createDatabase(local.d1);
  const seeded = await seedTwoOwners(local);
  alice = seeded.alice;
  bob = seeded.bob;
});

afterEach(async () => {
  await local.dispose();
});

describe('findSeatSettingsAsOwner', () => {
  it('未設定の自分の店には既定値を返す（null ではない）', async () => {
    const found = await findSeatSettingsAsOwner(db, alice.actor, alice.shopId);
    expect(found).toMatchObject({
      shopId: alice.shopId,
      capacity: DEFAULT_SEAT_SETTINGS.capacity,
      slotMinutes: DEFAULT_SEAT_SETTINGS.slotMinutes,
      maxParallel: DEFAULT_SEAT_SETTINGS.maxParallel,
      acceptsReservation: false,
    });
  });

  it('既定では予約を受け付けない（明示的に有効化するまで予約が入らない）', async () => {
    const found = await findSeatSettingsAsOwner(db, alice.actor, alice.shopId);
    expect(found?.acceptsReservation).toBe(false);
  });

  it('他人の店なら null を返す（未設定の既定値と区別する）', async () => {
    expect(await findSeatSettingsAsOwner(db, bob.actor, alice.shopId)).toBeNull();
  });

  it('保存済みなら保存値を返す', async () => {
    await upsertSeatSettingsAsOwner(db, alice.actor, alice.shopId, {
      capacity: 24,
      slotMinutes: 120,
      maxParallel: 3,
      acceptsReservation: true,
    });
    const found = await findSeatSettingsAsOwner(db, alice.actor, alice.shopId);
    expect(found).toMatchObject({
      capacity: 24,
      slotMinutes: 120,
      maxParallel: 3,
      acceptsReservation: true,
    });
  });
});

describe('upsertSeatSettingsAsOwner', () => {
  it('初回は INSERT になる', async () => {
    const saved = await upsertSeatSettingsAsOwner(db, alice.actor, alice.shopId, {
      capacity: 12,
      slotMinutes: 90,
      maxParallel: 2,
      acceptsReservation: true,
    });
    expect(saved?.capacity).toBe(12);
  });

  it('2 回目は UPDATE になり、行は 1 本のまま', async () => {
    await upsertSeatSettingsAsOwner(db, alice.actor, alice.shopId, {
      capacity: 12,
      slotMinutes: 90,
      maxParallel: 2,
      acceptsReservation: true,
    });
    await upsertSeatSettingsAsOwner(db, alice.actor, alice.shopId, {
      capacity: 30,
      slotMinutes: 60,
      maxParallel: 5,
      acceptsReservation: false,
    });
    const row = await local.d1
      .prepare(`SELECT COUNT(*) AS total FROM seat_settings WHERE shop_id = ?`)
      .bind(alice.shopId)
      .first<{ total: number }>();
    expect(row?.total).toBe(1);
    const found = await findSeatSettingsAsOwner(db, alice.actor, alice.shopId);
    expect(found).toMatchObject({
      capacity: 30,
      slotMinutes: 60,
      maxParallel: 5,
      acceptsReservation: false,
    });
  });

  it('予約受付を true → false に戻せる', async () => {
    await upsertSeatSettingsAsOwner(db, alice.actor, alice.shopId, {
      capacity: 10,
      slotMinutes: 90,
      maxParallel: 1,
      acceptsReservation: true,
    });
    const saved = await upsertSeatSettingsAsOwner(db, alice.actor, alice.shopId, {
      capacity: 10,
      slotMinutes: 90,
      maxParallel: 1,
      acceptsReservation: false,
    });
    expect(saved?.acceptsReservation).toBe(false);
  });

  it('他人の店には保存できず、行も作られない', async () => {
    expect(
      await upsertSeatSettingsAsOwner(db, bob.actor, alice.shopId, {
        capacity: 99,
        slotMinutes: 15,
        maxParallel: 1,
        acceptsReservation: true,
      }),
    ).toBeNull();
    const row = await local.d1
      .prepare(`SELECT COUNT(*) AS total FROM seat_settings WHERE shop_id = ?`)
      .bind(alice.shopId)
      .first<{ total: number }>();
    expect(row?.total).toBe(0);
  });

  it('自分の店の設定を、他人の店の設定として上書きできない', async () => {
    await upsertSeatSettingsAsOwner(db, bob.actor, bob.shopId, {
      capacity: 8,
      slotMinutes: 90,
      maxParallel: 1,
      acceptsReservation: true,
    });
    await upsertSeatSettingsAsOwner(db, bob.actor, alice.shopId, {
      capacity: 99,
      slotMinutes: 15,
      maxParallel: 1,
      acceptsReservation: false,
    });
    const bobSettings = await findSeatSettingsAsOwner(db, bob.actor, bob.shopId);
    expect(bobSettings?.capacity).toBe(8);
  });

  it('capacity が 500 ちょうどでも保存できる（DB の CHECK 境界）', async () => {
    const saved = await upsertSeatSettingsAsOwner(db, alice.actor, alice.shopId, {
      capacity: 500,
      slotMinutes: 15,
      maxParallel: 100,
      acceptsReservation: true,
    });
    expect(saved?.capacity).toBe(500);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/api -- src/repositories/owner-seat-repository.test.ts`
Expected: FAIL。`Failed to resolve import "./owner-seat-repository"` で全 11 件が落ちる。

- [ ] **Step 3: リポジトリを実装する**

```ts
// apps/api/src/repositories/owner-seat-repository.ts
// seat_settings は shop_id が主キーで、未設定の店には行が無い。
// 「未設定」と「他人の店」をどちらも 0 行にしてしまうと 404 の判断ができなくなるので、
// 所有権の確認（SQL）と、既定値の組み立て（表示用）を 2 段階に分ける。
import { eq } from 'drizzle-orm';
import type { SeatSettingsInput, ShopId } from '@meshimap/core';

import type { OwnerActor } from '../auth/actor';
import type { Database } from '../db/client';
import { seatSettings } from '../db/schema';
import { findOwnedShopId } from './owner-scope';

export type SeatSettingsRow = typeof seatSettings.$inferSelect;

/** 未設定の店に見せる初期値。acceptsReservation を false にしておくのは、
 *  設定した覚えのない店に予約が入る事故を防ぐため（スキーマの default とも一致） */
export const DEFAULT_SEAT_SETTINGS = {
  capacity: 10,
  slotMinutes: 90,
  maxParallel: 1,
  acceptsReservation: false,
} as const;

export async function findSeatSettingsAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
): Promise<SeatSettingsRow | null> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  if (ownedShopId === null) {
    return null;
  }
  const rows = await db
    .select()
    .from(seatSettings)
    .where(eq(seatSettings.shopId, ownedShopId))
    .limit(1);
  const row = rows[0];
  if (row !== undefined) {
    return row;
  }
  return { shopId: ownedShopId, ...DEFAULT_SEAT_SETTINGS };
}

export async function upsertSeatSettingsAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
  input: SeatSettingsInput,
): Promise<SeatSettingsRow | null> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  if (ownedShopId === null) {
    return null;
  }
  const values = {
    shopId: ownedShopId,
    capacity: input.capacity,
    slotMinutes: input.slotMinutes,
    maxParallel: input.maxParallel,
    acceptsReservation: input.acceptsReservation,
  };
  const saved = await db
    .insert(seatSettings)
    .values(values)
    .onConflictDoUpdate({
      target: seatSettings.shopId,
      set: {
        capacity: values.capacity,
        slotMinutes: values.slotMinutes,
        maxParallel: values.maxParallel,
        acceptsReservation: values.acceptsReservation,
      },
    })
    .returning();
  return saved[0] ?? null;
}
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/api -- src/repositories/owner-seat-repository.test.ts`
Expected: PASS（11 件）。

- [ ] **Step 5: わざと壊して検証が効いていることを確認する**

`findSeatSettingsAsOwner` から所有権の確認を外し、直接 `seat_settings` を引くだけにする。

```ts
// 一時的な改悪
export async function findSeatSettingsAsOwner(db, actor, shopId) {
  const rows = await db.select().from(seatSettings).where(eq(seatSettings.shopId, shopId)).limit(1);
  return rows[0] ?? { shopId, ...DEFAULT_SEAT_SETTINGS };
}
```

Run: `npm run test -w @meshimap/api -- src/repositories/owner-seat-repository.test.ts`
Expected: FAIL。「他人の店なら null を返す（未設定の既定値と区別する）」が `expected { shopId: 'shp_alice', capacity: 10, ... } to be null` で落ちる。「未設定だから既定値を返す」という一見無害な実装が、他人の店の存在を漏らす経路になっていたことが露呈する。

次に `upsertSeatSettingsAsOwner` の `values` で `shopId: ownedShopId` を `shopId`（引数のまま）に変える。所有権チェックは残っているのでほとんどのテストは通るが、**この変更だけでは落ちない**。落ちないこと自体が問題なので、代わりに所有権チェックの `return null` を `/* noop */` に変える。
Expected: FAIL。「他人の店には保存できず、行も作られない」が `expected 0 to be 1`（実際は行ができてしまう）で落ちる。

**両方確認したら元に戻し、再度テストが緑になることを確認する。**

- [ ] **Step 6: コミット**

```bash
git add apps/api/src/repositories/owner-seat-repository.ts apps/api/src/repositories/owner-seat-repository.test.ts
git commit -m "feat(api): 座席設定の取得（既定値つき）と upsert を追加"
```

---

## Task 8-9: レビュー一覧・返信・通報リポジトリ

**Files:**

- Create: `apps/api/src/repositories/owner-review-repository.ts`
- Test: `apps/api/src/repositories/owner-review-repository.test.ts`

**Interfaces:**

- Consumes: `findOwnedShopId` / `findOwnedReviewShopId`（8-4）、`reviewReplyInputSchema` / `reviewReportCreateSchema`（8-3）、`reviews` / `reviewReplies` / `reports`（既存スキーマ）、`REPORT_TARGET_TYPES`（api constants）、`seedTwoOwners`（8-4）
- Produces:
  - `type ReviewReplyRow = typeof reviewReplies.$inferSelect`
  - `type OwnerReviewEntry = { readonly review: typeof reviews.$inferSelect; readonly reply: ReviewReplyRow | null }`
  - `async function listShopReviewsAsOwner(db, actor, shopId): Promise<readonly OwnerReviewEntry[] | null>`
  - `async function countUnansweredReviewsAsOwner(db, actor, shopId): Promise<number | null>`
  - `async function upsertReviewReplyAsOwner(db, actor, reviewId: ReviewId, body: string): Promise<ReviewReplyRow | null>`
  - `async function deleteReviewReplyAsOwner(db, actor, reviewId: ReviewId): Promise<boolean>`
  - `async function createReviewReportAsOwner(db, actor, reviewId: ReviewId, reportId: string, input: { reason: string; detail: string | null }): Promise<boolean>`

### なぜ `review_replies` が PUT（upsert）なのか

`review_replies` は `review_id` が主キーである（`apps/api/src/db/schema/review.ts`）。1 レビューにつき返信は最大 1 件、という制約がスキーマに書いてある。したがって「作成」と「更新」を分ける意味が無く、`PUT /owner/reviews/:reviewId/reply` の 1 本で `onConflictDoUpdate` するのが素直である。POST と PATCH を分けると、クライアントが「まだ返信が無い」状態を先に知る必要が生じ、往復が 1 回増える。

### 通報は「申請」であって「削除」ではない

オーナーがレビューを消せてはならない。悪い評価を消す経路ができた時点で、レビュー機能が信用を失う。`POST /owner/reviews/:reviewId/report` は `reports` テーブルに `target_type = 'review'` の行を 1 本作るだけで、レビュー本体には一切触れない。判断は Phase 9 の管理者が行う。テストでこの「触れない」ことを明示的に確認する。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// apps/api/src/repositories/owner-review-repository.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toReviewId } from '@meshimap/core';

import { createMigratedD1 } from '../db/testing/local-d1';
import type { LocalD1 } from '../db/testing/local-d1';
import { createDatabase } from '../db/client';
import type { Database } from '../db/client';
import { seedTwoOwners } from './testing/owner-fixtures';
import type { OwnerFixture } from './testing/owner-fixtures';
import {
  countUnansweredReviewsAsOwner,
  createReviewReportAsOwner,
  deleteReviewReplyAsOwner,
  listShopReviewsAsOwner,
  upsertReviewReplyAsOwner,
} from './owner-review-repository';

let local: LocalD1;
let db: Database;
let alice: OwnerFixture;
let bob: OwnerFixture;

async function insertReview(
  reviewId: string,
  shopId: string,
  userId: string,
  rating: number,
  createdAt: number,
): Promise<void> {
  await local.d1
    .prepare(
      `INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)`,
    )
    .bind(userId, `客${userId}`, `${userId}@example.com`)
    .run();
  await local.d1
    .prepare(
      // reviews に updated_at 列は無い（apps/api/src/db/schema/review.ts:65 は created_at のみ）
      `INSERT INTO reviews (id, shop_id, user_id, rating, body, status, created_at)
       VALUES (?, ?, ?, ?, '感想です', 'published', ?)`,
    )
    .bind(reviewId, shopId, userId, rating, createdAt)
    .run();
}

beforeEach(async () => {
  local = await createMigratedD1();
  db = createDatabase(local.d1);
  const seeded = await seedTwoOwners(local);
  alice = seeded.alice;
  bob = seeded.bob;
});

afterEach(async () => {
  await local.dispose();
});

describe('listShopReviewsAsOwner', () => {
  it('自分の店のレビューを新しい順に返す', async () => {
    await insertReview('rvw_old', alice.shopId, 'usr_c1', 4, 1000);
    await insertReview('rvw_new', alice.shopId, 'usr_c2', 5, 2000);
    const listed = await listShopReviewsAsOwner(db, alice.actor, alice.shopId);
    expect(listed?.map((entry) => entry.review.id)).toEqual(['rvw_new', 'rvw_old']);
  });

  it('返信が無いレビューは reply が null になる', async () => {
    await insertReview('rvw_1', alice.shopId, 'usr_c3', 5, 1000);
    const listed = await listShopReviewsAsOwner(db, alice.actor, alice.shopId);
    expect(listed?.[0]?.reply).toBeNull();
  });

  it('返信があるレビューは reply に本文が入る', async () => {
    await insertReview('rvw_2', alice.shopId, 'usr_c4', 5, 1000);
    await upsertReviewReplyAsOwner(db, alice.actor, toReviewId('rvw_2'), 'ありがとうございます');
    const listed = await listShopReviewsAsOwner(db, alice.actor, alice.shopId);
    expect(listed?.[0]?.reply?.body).toBe('ありがとうございます');
  });

  it('他人の店なら null を返す', async () => {
    expect(await listShopReviewsAsOwner(db, bob.actor, alice.shopId)).toBeNull();
  });

  it('他店のレビューは混ざらない', async () => {
    await insertReview('rvw_a', alice.shopId, 'usr_c5', 5, 1000);
    await insertReview('rvw_b', bob.shopId, 'usr_c6', 1, 2000);
    const listed = await listShopReviewsAsOwner(db, alice.actor, alice.shopId);
    expect(listed?.map((entry) => entry.review.id)).toEqual(['rvw_a']);
  });

  it('レビューが 0 件でも空配列を返す', async () => {
    expect(await listShopReviewsAsOwner(db, alice.actor, alice.shopId)).toEqual([]);
  });
});

describe('countUnansweredReviewsAsOwner', () => {
  it('返信の無いレビューの数を返す', async () => {
    await insertReview('rvw_u1', alice.shopId, 'usr_d1', 5, 1000);
    await insertReview('rvw_u2', alice.shopId, 'usr_d2', 4, 2000);
    await insertReview('rvw_u3', alice.shopId, 'usr_d3', 3, 3000);
    await upsertReviewReplyAsOwner(db, alice.actor, toReviewId('rvw_u2'), '返信済み');
    expect(await countUnansweredReviewsAsOwner(db, alice.actor, alice.shopId)).toBe(2);
  });

  it('全部返信済みなら 0 を返す', async () => {
    await insertReview('rvw_v1', alice.shopId, 'usr_e1', 5, 1000);
    await upsertReviewReplyAsOwner(db, alice.actor, toReviewId('rvw_v1'), '返信済み');
    expect(await countUnansweredReviewsAsOwner(db, alice.actor, alice.shopId)).toBe(0);
  });

  it('レビューが 0 件なら 0 を返す（null ではない）', async () => {
    expect(await countUnansweredReviewsAsOwner(db, alice.actor, alice.shopId)).toBe(0);
  });

  it('他人の店なら null を返す（0 と区別する）', async () => {
    expect(await countUnansweredReviewsAsOwner(db, bob.actor, alice.shopId)).toBeNull();
  });
});

describe('upsertReviewReplyAsOwner', () => {
  beforeEach(async () => {
    await insertReview('rvw_r', alice.shopId, 'usr_f1', 5, 1000);
  });

  it('自分の店のレビューに返信できる', async () => {
    const saved = await upsertReviewReplyAsOwner(
      db,
      alice.actor,
      toReviewId('rvw_r'),
      'ご来店ありがとうございます',
    );
    expect(saved).toMatchObject({
      reviewId: 'rvw_r',
      shopId: alice.shopId,
      body: 'ご来店ありがとうございます',
    });
  });

  it('2 回目は上書きになり、行は 1 本のまま', async () => {
    await upsertReviewReplyAsOwner(db, alice.actor, toReviewId('rvw_r'), '一回目');
    const saved = await upsertReviewReplyAsOwner(db, alice.actor, toReviewId('rvw_r'), '二回目');
    expect(saved?.body).toBe('二回目');
    const row = await local.d1
      .prepare(`SELECT COUNT(*) AS total FROM review_replies WHERE review_id = 'rvw_r'`)
      .first<{ total: number }>();
    expect(row?.total).toBe(1);
  });

  it('他人の店のレビューには返信できず、行も作られない', async () => {
    expect(
      await upsertReviewReplyAsOwner(db, bob.actor, toReviewId('rvw_r'), '勝手に返信'),
    ).toBeNull();
    const row = await local.d1
      .prepare(`SELECT review_id FROM review_replies WHERE review_id = 'rvw_r'`)
      .first();
    expect(row).toBeNull();
  });

  it('他人の店の既存返信を上書きできない', async () => {
    await upsertReviewReplyAsOwner(db, alice.actor, toReviewId('rvw_r'), '正しい返信');
    await upsertReviewReplyAsOwner(db, bob.actor, toReviewId('rvw_r'), '改竄');
    const row = await local.d1
      .prepare(`SELECT body FROM review_replies WHERE review_id = 'rvw_r'`)
      .first<{ body: string }>();
    expect(row?.body).toBe('正しい返信');
  });

  it('存在しないレビューには返信できない', async () => {
    expect(
      await upsertReviewReplyAsOwner(db, alice.actor, toReviewId('rvw_ghost'), '幽霊'),
    ).toBeNull();
  });
});

describe('deleteReviewReplyAsOwner', () => {
  it('自分の返信を削除できる', async () => {
    await insertReview('rvw_dr', alice.shopId, 'usr_g1', 5, 1000);
    await upsertReviewReplyAsOwner(db, alice.actor, toReviewId('rvw_dr'), '消す');
    expect(await deleteReviewReplyAsOwner(db, alice.actor, toReviewId('rvw_dr'))).toBe(true);
  });

  it('返信を削除してもレビュー本体は残る', async () => {
    await insertReview('rvw_dr2', alice.shopId, 'usr_g2', 5, 1000);
    await upsertReviewReplyAsOwner(db, alice.actor, toReviewId('rvw_dr2'), '消す');
    await deleteReviewReplyAsOwner(db, alice.actor, toReviewId('rvw_dr2'));
    const row = await local.d1.prepare(`SELECT id FROM reviews WHERE id = 'rvw_dr2'`).first();
    expect(row).not.toBeNull();
  });

  it('他人の店の返信は削除できず、行が残る', async () => {
    await insertReview('rvw_dr3', alice.shopId, 'usr_g3', 5, 1000);
    await upsertReviewReplyAsOwner(db, alice.actor, toReviewId('rvw_dr3'), '残る');
    expect(await deleteReviewReplyAsOwner(db, bob.actor, toReviewId('rvw_dr3'))).toBe(false);
    const row = await local.d1
      .prepare(`SELECT body FROM review_replies WHERE review_id = 'rvw_dr3'`)
      .first();
    expect(row).not.toBeNull();
  });
});

describe('createReviewReportAsOwner', () => {
  beforeEach(async () => {
    await insertReview('rvw_rep', alice.shopId, 'usr_h1', 1, 1000);
  });

  it('通報を作成できる', async () => {
    expect(
      await createReviewReportAsOwner(db, alice.actor, toReviewId('rvw_rep'), 'rpt_1', {
        reason: '事実無根',
        detail: '来店記録がありません',
      }),
    ).toBe(true);
    const row = await local.d1
      .prepare(`SELECT target_type, target_id, status FROM reports WHERE id = 'rpt_1'`)
      .first<{ target_type: string; target_id: string; status: string }>();
    expect(row).toEqual({ target_type: 'review', target_id: 'rvw_rep', status: 'open' });
  });

  it('通報してもレビュー本体は変わらない（オーナーは消せない）', async () => {
    const before = await local.d1.prepare(`SELECT * FROM reviews WHERE id = 'rvw_rep'`).first();
    await createReviewReportAsOwner(db, alice.actor, toReviewId('rvw_rep'), 'rpt_2', {
      reason: '事実無根',
      detail: null,
    });
    const after = await local.d1.prepare(`SELECT * FROM reviews WHERE id = 'rvw_rep'`).first();
    expect(after).toEqual(before);
  });

  it('同じレビューを 2 回通報すると 2 回目は false（uq_reports_reporter_target）', async () => {
    await createReviewReportAsOwner(db, alice.actor, toReviewId('rvw_rep'), 'rpt_3', {
      reason: 'A',
      detail: null,
    });
    expect(
      await createReviewReportAsOwner(db, alice.actor, toReviewId('rvw_rep'), 'rpt_4', {
        reason: 'B',
        detail: null,
      }),
    ).toBe(false);
  });

  it('他人の店のレビューは通報できない', async () => {
    expect(
      await createReviewReportAsOwner(db, bob.actor, toReviewId('rvw_rep'), 'rpt_5', {
        reason: 'X',
        detail: null,
      }),
    ).toBe(false);
    const row = await local.d1.prepare(`SELECT id FROM reports WHERE id = 'rpt_5'`).first();
    expect(row).toBeNull();
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/api -- src/repositories/owner-review-repository.test.ts`
Expected: FAIL。`Failed to resolve import "./owner-review-repository"` で全 22 件が落ちる。

- [ ] **Step 3: リポジトリを実装する**

```ts
// apps/api/src/repositories/owner-review-repository.ts
// オーナーはレビューを「消せない」。通報（reports への 1 行追加）ができるだけで、
// 判断は管理者が行う。悪い評価を当事者が消せる経路を作らないための設計。
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { ReviewId, ShopId } from '@meshimap/core';

import type { OwnerActor } from '../auth/actor';
import type { Database } from '../db/client';
import { reports, reviewReplies, reviews } from '../db/schema';
import { findOwnedReviewShopId, findOwnedShopId } from './owner-scope';

export type ReviewRow = typeof reviews.$inferSelect;
export type ReviewReplyRow = typeof reviewReplies.$inferSelect;
export type OwnerReviewEntry = {
  readonly review: ReviewRow;
  readonly reply: ReviewReplyRow | null;
};

const REPORT_TARGET_TYPE_REVIEW = 'review';
const REPORT_STATUS_OPEN = 'open';

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}

export async function listShopReviewsAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
): Promise<readonly OwnerReviewEntry[] | null> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  if (ownedShopId === null) {
    return null;
  }
  const rows = await db
    .select({ review: reviews, reply: reviewReplies })
    .from(reviews)
    .leftJoin(reviewReplies, eq(reviewReplies.reviewId, reviews.id))
    .where(eq(reviews.shopId, ownedShopId))
    .orderBy(desc(reviews.createdAt));
  return rows.map((row) => ({ review: row.review, reply: row.reply }));
}

/** 返信済みと未返信を区別する。0 件（返信済み）と null（他人の店）を混同しないよう戻り値を分ける */
export async function countUnansweredReviewsAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
): Promise<number | null> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  if (ownedShopId === null) {
    return null;
  }
  const rows = await db
    .select({ total: sql<number>`count(*)` })
    .from(reviews)
    .leftJoin(reviewReplies, eq(reviewReplies.reviewId, reviews.id))
    .where(and(eq(reviews.shopId, ownedShopId), isNull(reviewReplies.reviewId)));
  return rows[0]?.total ?? 0;
}

export async function upsertReviewReplyAsOwner(
  db: Database,
  actor: OwnerActor,
  reviewId: ReviewId,
  body: string,
): Promise<ReviewReplyRow | null> {
  // review_id から shops.owner_id まで JOIN で遡る。URL に shopId が無いので経路はここだけ
  const ownedShopId = await findOwnedReviewShopId(db, actor, reviewId);
  if (ownedShopId === null) {
    return null;
  }
  // review_id が主キーなので「1 レビュー 1 返信」はスキーマが保証する。作成と更新を分ける必要が無い
  const saved = await db
    .insert(reviewReplies)
    .values({ reviewId, shopId: ownedShopId, body })
    .onConflictDoUpdate({ target: reviewReplies.reviewId, set: { body } })
    .returning();
  return saved[0] ?? null;
}

export async function deleteReviewReplyAsOwner(
  db: Database,
  actor: OwnerActor,
  reviewId: ReviewId,
): Promise<boolean> {
  const ownedShopId = await findOwnedReviewShopId(db, actor, reviewId);
  if (ownedShopId === null) {
    return false;
  }
  const deleted = await db
    .delete(reviewReplies)
    .where(and(eq(reviewReplies.reviewId, reviewId), eq(reviewReplies.shopId, ownedShopId)))
    .returning({ reviewId: reviewReplies.reviewId });
  return deleted.length > 0;
}

export async function createReviewReportAsOwner(
  db: Database,
  actor: OwnerActor,
  reviewId: ReviewId,
  reportId: string,
  input: { readonly reason: string; readonly detail: string | null },
): Promise<boolean> {
  const ownedShopId = await findOwnedReviewShopId(db, actor, reviewId);
  if (ownedShopId === null) {
    return false;
  }
  try {
    await db.insert(reports).values({
      id: reportId,
      reporterId: actor.userId,
      targetType: REPORT_TARGET_TYPE_REVIEW,
      targetId: reviewId,
      reason: input.reason,
      detail: input.detail,
      status: REPORT_STATUS_OPEN,
    });
    return true;
  } catch (error) {
    // 同じ人が同じ対象を 2 回通報するのは uq_reports_reporter_target が拒否する。冪等に false
    if (isUniqueViolation(error)) {
      return false;
    }
    throw error;
  }
}
```

**注意：** `REPORT_STATUS_OPEN` の値は `apps/api/src/db/constants.ts` の `REPORT_STATUSES` の先頭要素に合わせること。実装時に実物を開いて確認し、`REPORT_STATUSES[0]` が `'open'` でなければテストの期待値ごと合わせる。

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/api -- src/repositories/owner-review-repository.test.ts`
Expected: PASS（22 件）。

- [ ] **Step 5: わざと壊して検証が効いていることを確認する**

`upsertReviewReplyAsOwner` の所有権解決を `findOwnedReviewShopId` から「レビューの shopId をそのまま使う」に一時的に変える。

```ts
// 一時的な改悪
const rows = await db
  .select({ shopId: reviews.shopId })
  .from(reviews)
  .where(eq(reviews.id, reviewId))
  .limit(1);
const ownedShopId = rows[0]?.shopId ?? null;
```

Run: `npm run test -w @meshimap/api -- src/repositories/owner-review-repository.test.ts`
Expected: FAIL。「他人の店のレビューには返信できず、行も作られない」と「他人の店の既存返信を上書きできない」の 2 件が落ちる。後者は `expected '改竄' to be '正しい返信'` という形で、**他人の店の返信を書き換えられてしまう**という最悪の退行を示す。

次に `countUnansweredReviewsAsOwner` の `isNull(reviewReplies.reviewId)` を外す。
Expected: FAIL。「返信の無いレビューの数を返す」が `expected 3 to be 2` で落ちる。

**両方確認したら元に戻し、再度テストが緑になることを確認する。**

- [ ] **Step 6: コミット**

```bash
git add apps/api/src/repositories/owner-review-repository.ts apps/api/src/repositories/owner-review-repository.test.ts
git commit -m "feat(api): レビュー一覧・返信の upsert・通報申請を追加"
```

---

## Task 8-10: クーポンリポジトリ

**Files:**

- Create: `apps/api/src/repositories/owner-campaign-repository.ts`
- Test: `apps/api/src/repositories/owner-campaign-repository.test.ts`

**Interfaces:**

- Consumes: `findOwnedShopId` / `findOwnedCampaignShopId`（8-4）、`campaignInputSchema` / `CampaignInput`（8-3）、`campaigns`（8-1）、`seedTwoOwners`（8-4）
- Produces:
  - `async function listCampaignsAsOwner(db, actor, shopId): Promise<readonly CampaignRow[] | null>`
  - `async function createCampaignAsOwner(db, actor, shopId, campaignId: string, input: CampaignInput, now: Date): Promise<CampaignRow | null>`
  - `async function updateCampaignAsOwner(db, actor, campaignId: string, input: CampaignInput): Promise<CampaignRow | null>`
  - `async function deleteCampaignAsOwner(db, actor, campaignId: string): Promise<boolean>`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// apps/api/src/repositories/owner-campaign-repository.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMigratedD1 } from '../db/testing/local-d1';
import type { LocalD1 } from '../db/testing/local-d1';
import { createDatabase } from '../db/client';
import type { Database } from '../db/client';
import { seedTwoOwners } from './testing/owner-fixtures';
import type { OwnerFixture } from './testing/owner-fixtures';
import {
  createCampaignAsOwner,
  deleteCampaignAsOwner,
  listCampaignsAsOwner,
  updateCampaignAsOwner,
} from './owner-campaign-repository';

let local: LocalD1;
let db: Database;
let alice: OwnerFixture;
let bob: OwnerFixture;

const NOW = new Date('2026-09-15T00:00:00Z');
const baseInput = {
  title: '開店記念',
  body: '全品 10% オフ',
  discountType: 'percent',
  discountValue: 10,
  startsOn: '2026-10-01',
  endsOn: '2026-10-31',
  status: 'published',
} as const;

beforeEach(async () => {
  local = await createMigratedD1();
  db = createDatabase(local.d1);
  const seeded = await seedTwoOwners(local);
  alice = seeded.alice;
  bob = seeded.bob;
});

afterEach(async () => {
  await local.dispose();
});

describe('createCampaignAsOwner', () => {
  it('自分の店にクーポンを作れる', async () => {
    const created = await createCampaignAsOwner(
      db,
      alice.actor,
      alice.shopId,
      'cmp_1',
      baseInput,
      NOW,
    );
    expect(created).toMatchObject({
      id: 'cmp_1',
      shopId: alice.shopId,
      discountType: 'percent',
      discountValue: 10,
    });
  });

  it('gift（金額なし）のクーポンを作れる', async () => {
    const created = await createCampaignAsOwner(
      db,
      alice.actor,
      alice.shopId,
      'cmp_2',
      { ...baseInput, discountType: 'gift', discountValue: 0, body: 'ドリンク 1 杯サービス' },
      NOW,
    );
    expect(created).toMatchObject({ discountType: 'gift', discountValue: 0 });
  });

  it('下書き（draft）として作れる', async () => {
    const created = await createCampaignAsOwner(
      db,
      alice.actor,
      alice.shopId,
      'cmp_3',
      { ...baseInput, status: 'draft' },
      NOW,
    );
    expect(created?.status).toBe('draft');
  });

  it('1 日だけのクーポン（開始日 = 終了日）を作れる', async () => {
    const created = await createCampaignAsOwner(
      db,
      alice.actor,
      alice.shopId,
      'cmp_4',
      { ...baseInput, startsOn: '2026-10-01', endsOn: '2026-10-01' },
      NOW,
    );
    expect(created?.endsOn).toBe('2026-10-01');
  });

  it('他人の店には作れず、行も残らない', async () => {
    expect(
      await createCampaignAsOwner(db, bob.actor, alice.shopId, 'cmp_x', baseInput, NOW),
    ).toBeNull();
    const row = await local.d1.prepare(`SELECT id FROM campaigns WHERE id = 'cmp_x'`).first();
    expect(row).toBeNull();
  });
});

describe('listCampaignsAsOwner', () => {
  it('開始日の昇順に並ぶ', async () => {
    await createCampaignAsOwner(
      db,
      alice.actor,
      alice.shopId,
      'cmp_late',
      { ...baseInput, startsOn: '2026-11-01', endsOn: '2026-11-30' },
      NOW,
    );
    await createCampaignAsOwner(db, alice.actor, alice.shopId, 'cmp_early', baseInput, NOW);
    const listed = await listCampaignsAsOwner(db, alice.actor, alice.shopId);
    expect(listed?.map((row) => row.id)).toEqual(['cmp_early', 'cmp_late']);
  });

  it('他店のクーポンは混ざらない', async () => {
    await createCampaignAsOwner(db, bob.actor, bob.shopId, 'cmp_bob', baseInput, NOW);
    await createCampaignAsOwner(db, alice.actor, alice.shopId, 'cmp_alice', baseInput, NOW);
    const listed = await listCampaignsAsOwner(db, alice.actor, alice.shopId);
    expect(listed?.map((row) => row.id)).toEqual(['cmp_alice']);
  });

  it('他人の店なら null を返す', async () => {
    expect(await listCampaignsAsOwner(db, bob.actor, alice.shopId)).toBeNull();
  });

  it('0 件でも空配列を返す', async () => {
    expect(await listCampaignsAsOwner(db, alice.actor, alice.shopId)).toEqual([]);
  });
});

describe('updateCampaignAsOwner', () => {
  beforeEach(async () => {
    await createCampaignAsOwner(db, alice.actor, alice.shopId, 'cmp_u', baseInput, NOW);
  });

  it('自分の店のクーポンを更新できる', async () => {
    const updated = await updateCampaignAsOwner(db, alice.actor, 'cmp_u', {
      ...baseInput,
      title: '延長戦',
      endsOn: '2026-11-30',
    });
    expect(updated).toMatchObject({ title: '延長戦', endsOn: '2026-11-30' });
  });

  it('公開を終了（ended）にできる', async () => {
    const updated = await updateCampaignAsOwner(db, alice.actor, 'cmp_u', {
      ...baseInput,
      status: 'ended',
    });
    expect(updated?.status).toBe('ended');
  });

  it('他人の店のクーポンは更新できず、値も変わらない', async () => {
    expect(
      await updateCampaignAsOwner(db, bob.actor, 'cmp_u', { ...baseInput, title: '乗っ取り' }),
    ).toBeNull();
    const row = await local.d1
      .prepare(`SELECT title FROM campaigns WHERE id = 'cmp_u'`)
      .first<{ title: string }>();
    expect(row?.title).toBe('開店記念');
  });

  it('存在しないクーポンの更新は null を返す', async () => {
    expect(await updateCampaignAsOwner(db, alice.actor, 'cmp_ghost', baseInput)).toBeNull();
  });

  it('shop_id は付け替えられない（他店へ移動できない）', async () => {
    await updateCampaignAsOwner(db, alice.actor, 'cmp_u', { ...baseInput, title: '変更' });
    const row = await local.d1
      .prepare(`SELECT shop_id FROM campaigns WHERE id = 'cmp_u'`)
      .first<{ shop_id: string }>();
    expect(row?.shop_id).toBe(alice.shopId);
  });
});

describe('deleteCampaignAsOwner', () => {
  it('自分の店のクーポンを削除できる', async () => {
    await createCampaignAsOwner(db, alice.actor, alice.shopId, 'cmp_d', baseInput, NOW);
    expect(await deleteCampaignAsOwner(db, alice.actor, 'cmp_d')).toBe(true);
    expect(await listCampaignsAsOwner(db, alice.actor, alice.shopId)).toEqual([]);
  });

  it('他人の店のクーポンは削除できず、行が残る', async () => {
    await createCampaignAsOwner(db, alice.actor, alice.shopId, 'cmp_k', baseInput, NOW);
    expect(await deleteCampaignAsOwner(db, bob.actor, 'cmp_k')).toBe(false);
    const row = await local.d1.prepare(`SELECT id FROM campaigns WHERE id = 'cmp_k'`).first();
    expect(row).not.toBeNull();
  });

  it('存在しないクーポンの削除は false を返す', async () => {
    expect(await deleteCampaignAsOwner(db, alice.actor, 'cmp_nowhere')).toBe(false);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/api -- src/repositories/owner-campaign-repository.test.ts`
Expected: FAIL。`Failed to resolve import "./owner-campaign-repository"` で全 16 件が落ちる。

- [ ] **Step 3: リポジトリを実装する**

```ts
// apps/api/src/repositories/owner-campaign-repository.ts
// 更新・削除は URL に shopId を含まないので、findOwnedCampaignShopId で
// campaign_id → shops.owner_id を JOIN で遡ってから、その shopId を WHERE に残す。
import { and, asc, eq } from 'drizzle-orm';
import type { CampaignInput, ShopId } from '@meshimap/core';

import type { OwnerActor } from '../auth/actor';
import type { Database } from '../db/client';
import { campaigns } from '../db/schema';
import type { CampaignRow } from '../db/schema/campaign';
import { findOwnedCampaignShopId, findOwnedShopId } from './owner-scope';

export async function listCampaignsAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
): Promise<readonly CampaignRow[] | null> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  if (ownedShopId === null) {
    return null;
  }
  return await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.shopId, ownedShopId))
    .orderBy(asc(campaigns.startsOn));
}

export async function createCampaignAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
  campaignId: string,
  input: CampaignInput,
  now: Date,
): Promise<CampaignRow | null> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  if (ownedShopId === null) {
    return null;
  }
  const inserted = await db
    .insert(campaigns)
    .values({
      id: campaignId,
      shopId: ownedShopId,
      title: input.title,
      body: input.body,
      discountType: input.discountType,
      discountValue: input.discountValue,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      status: input.status,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return inserted[0] ?? null;
}

export async function updateCampaignAsOwner(
  db: Database,
  actor: OwnerActor,
  campaignId: string,
  input: CampaignInput,
): Promise<CampaignRow | null> {
  const ownedShopId = await findOwnedCampaignShopId(db, actor, campaignId);
  if (ownedShopId === null) {
    return null;
  }
  // shopId は set に含めない。クーポンを他店へ移動させる経路を作らないため
  const updated = await db
    .update(campaigns)
    .set({
      title: input.title,
      body: input.body,
      discountType: input.discountType,
      discountValue: input.discountValue,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      status: input.status,
    })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.shopId, ownedShopId)))
    .returning();
  return updated[0] ?? null;
}

export async function deleteCampaignAsOwner(
  db: Database,
  actor: OwnerActor,
  campaignId: string,
): Promise<boolean> {
  const ownedShopId = await findOwnedCampaignShopId(db, actor, campaignId);
  if (ownedShopId === null) {
    return false;
  }
  const deleted = await db
    .delete(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.shopId, ownedShopId)))
    .returning({ id: campaigns.id });
  return deleted.length > 0;
}
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/api -- src/repositories/owner-campaign-repository.test.ts`
Expected: PASS（16 件）。

- [ ] **Step 5: わざと壊して検証が効いていることを確認する**

`updateCampaignAsOwner` の `set` に `shopId: input.shopId` 相当を足せる形にするのは型が許さないので、代わりに `findOwnedCampaignShopId` を `findOwnedShopId` に取り違えた実装を再現する。`updateCampaignAsOwner` の冒頭を次のように一時変更する。

```ts
// 一時的な改悪：所有権チェックを丸ごと省く
const ownedShopId =
  (
    await db
      .select({ shopId: campaigns.shopId })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1)
  )[0]?.shopId ?? null;
```

Run: `npm run test -w @meshimap/api -- src/repositories/owner-campaign-repository.test.ts`
Expected: FAIL。「他人の店のクーポンは更新できず、値も変わらない」が `expected '乗っ取り' to be '開店記念'` で落ちる。クーポン ID だけを知っていれば誰でも書き換えられる状態が検出される。

次に `deleteCampaignAsOwner` の `where` から `eq(campaigns.shopId, ownedShopId)` を外す。
Expected: このケースでは `findOwnedCampaignShopId` が既に所有権を確かめているので**落ちない**。これは「二重防御の片方を外しても落ちない」典型例である。ミューテーションテストでも同じ理由で生き残る。対応は「除外」ではなく**テストを足す**こと：同じオーナーが 2 店舗を持ち、店舗 A のクーポン ID で削除を要求したときに店舗 B のクーポンが消えないことを確認するテストを追加する（`campaigns.id` は主キーなので実際には起きないが、将来 `id` が店舗内ユニークに変わったときの回帰として意味がある）。**追加してから元に戻す。**

- [ ] **Step 6: コミット**

```bash
git add apps/api/src/repositories/owner-campaign-repository.ts apps/api/src/repositories/owner-campaign-repository.test.ts
git commit -m "feat(api): クーポンの作成・一覧・更新・削除を追加"
```

---

## Task 8-11: KPI 集計リポジトリと閲覧記録

**Files:**

- Create: `apps/api/src/lib/stats-range.ts`
- Create: `apps/api/src/lib/stats-range.test.ts`
- Create: `apps/api/src/repositories/shop-stats-repository.ts`
- Test: `apps/api/src/repositories/shop-stats-repository.test.ts`

**Interfaces:**

- Consumes: `findOwnedShopId`（8-4）、`shopDailyStats`（8-1）、`favorites` / `reservations` / `reviews`（既存スキーマ）、`toJstClock` / `toJstDate` / `addJstDays` / `JstDate`（`@meshimap/core`）、`seedTwoOwners`（8-4）
- Produces:
  - `stats-range.ts`:
    - `const STATS_RANGE_DAYS = [7, 30, 90] as const`
    - `type StatsRangeDays = (typeof STATS_RANGE_DAYS)[number]`
    - `function buildDateKeys(endDate: JstDate, days: number): readonly JstDate[]`
    - `function fillDailySeries(keys: readonly JstDate[], rows: readonly { date: string; value: number }[]): readonly DailyPoint[]`
    - `function percentageChange(current: number, previous: number): number | null`
    - `type DailyPoint = { readonly date: string; readonly value: number }`
  - `shop-stats-repository.ts`:
    - `type ShopStatsSummary = { readonly days: StatsRangeDays; readonly views: MetricSeries; readonly favorites: MetricSeries; readonly reservations: MetricSeries; readonly ratings: MetricSeries }`
    - `type MetricSeries = { readonly points: readonly DailyPoint[]; readonly total: number; readonly previousTotal: number; readonly changeRate: number | null }`
    - `async function loadShopStatsAsOwner(db, actor, shopId, days: StatsRangeDays, now: Date): Promise<ShopStatsSummary | null>`
    - `async function recordShopView(db, shopId: string, now: Date): Promise<void>`

### なぜ日付バケットを純関数に切り出すのか

「直近 7 日」は `[今日 - 6, ..., 今日]` の 7 個の JST 日付である。この計算は SQL に混ぜると検証しづらく、月境界・年境界・うるう年でバグる。純関数に切り出せば、`buildDateKeys(toJstDate('2026-03-01'), 3)` が `['2026-02-27', '2026-02-28', '2026-03-01']` を返すことを直接テストできる。ミューテーションテストが最も効く形でもある。

### なぜ JST で日を切るのか

`created_at` はエポックミリ秒（UTC）で保存されている。UTC で日を切ると、日本時間の 00:00〜09:00 のイベントが前日に計上され、オーナーが見る「昨日の予約数」が実感とズレる。`@meshimap/core` の `toJstClock` が既に +9 時間して `getUTC*` で読む実装になっているので、それを使う。SQL 側では `date((created_at + 32400000) / 1000, 'unixepoch')` で同じことをする（32_400_000 = 9 時間のミリ秒）。

### 前期間比の出し方

「直近 7 日」の前期間は「その前の 7 日」である。`changeRate` は `(current - previous) / previous`。`previous` が 0 のときは割れないので `null` を返し、UI 側は「—」と表示する。**0 を返してはならない。** 「増減なし」と「比較できない」は別の情報である。

- [ ] **Step 1: stats-range の失敗するテストを書く**

```ts
// apps/api/src/lib/stats-range.test.ts
import { describe, expect, it } from 'vitest';
import { toJstDate } from '@meshimap/core';

import { buildDateKeys, fillDailySeries, percentageChange, STATS_RANGE_DAYS } from './stats-range';

describe('STATS_RANGE_DAYS', () => {
  it('設計書 §5.2 の期間切替（7 / 30 / 90 日）と一致する', () => {
    expect(STATS_RANGE_DAYS).toEqual([7, 30, 90]);
  });
});

describe('buildDateKeys', () => {
  it('末日を含む n 日ぶんを古い順に返す', () => {
    expect(buildDateKeys(toJstDate('2026-09-15'), 3)).toEqual([
      '2026-09-13',
      '2026-09-14',
      '2026-09-15',
    ]);
  });

  it('1 日ぶんなら末日だけを返す', () => {
    expect(buildDateKeys(toJstDate('2026-09-15'), 1)).toEqual(['2026-09-15']);
  });

  it('月をまたいでも正しい日付になる', () => {
    expect(buildDateKeys(toJstDate('2026-03-01'), 3)).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
    ]);
  });

  it('うるう年の 2 月 29 日をまたげる', () => {
    expect(buildDateKeys(toJstDate('2028-03-01'), 2)).toEqual(['2028-02-29', '2028-03-01']);
  });

  it('年をまたいでも正しい日付になる', () => {
    expect(buildDateKeys(toJstDate('2027-01-01'), 2)).toEqual(['2026-12-31', '2027-01-01']);
  });

  it('90 日ぶんは 90 要素で、先頭と末尾が想定どおり', () => {
    const keys = buildDateKeys(toJstDate('2026-09-15'), 90);
    expect(keys).toHaveLength(90);
    expect(keys[0]).toBe('2026-06-18');
    expect(keys[89]).toBe('2026-09-15');
  });

  it('0 日ぶんは空配列を返す', () => {
    expect(buildDateKeys(toJstDate('2026-09-15'), 0)).toEqual([]);
  });
});

describe('fillDailySeries', () => {
  const keys = [toJstDate('2026-09-13'), toJstDate('2026-09-14'), toJstDate('2026-09-15')];

  it('データのある日はその値、無い日は 0 になる', () => {
    expect(fillDailySeries(keys, [{ date: '2026-09-14', value: 5 }])).toEqual([
      { date: '2026-09-13', value: 0 },
      { date: '2026-09-14', value: 5 },
      { date: '2026-09-15', value: 0 },
    ]);
  });

  it('データが 1 件も無ければ全部 0 になる（閲覧記録がまだ無い店）', () => {
    expect(fillDailySeries(keys, []).every((point) => point.value === 0)).toBe(true);
  });

  it('期間外のデータは無視する', () => {
    expect(
      fillDailySeries(keys, [{ date: '2026-09-01', value: 99 }]).map((point) => point.value),
    ).toEqual([0, 0, 0]);
  });

  it('必ず keys と同じ長さ・同じ順序の配列を返す', () => {
    const filled = fillDailySeries(keys, [{ date: '2026-09-15', value: 3 }]);
    expect(filled.map((point) => point.date)).toEqual(['2026-09-13', '2026-09-14', '2026-09-15']);
  });
});

describe('percentageChange', () => {
  it('増加は正の比率になる', () => {
    expect(percentageChange(150, 100)).toBeCloseTo(0.5);
  });

  it('減少は負の比率になる', () => {
    expect(percentageChange(50, 100)).toBeCloseTo(-0.5);
  });

  it('変化なしは 0 になる', () => {
    expect(percentageChange(100, 100)).toBe(0);
  });

  it('前期間が 0 なら null を返す（「増減なし」と「比較できない」を区別する）', () => {
    expect(percentageChange(10, 0)).toBeNull();
  });

  it('前期間も今期間も 0 なら null を返す', () => {
    expect(percentageChange(0, 0)).toBeNull();
  });

  it('今期間が 0 で前期間が正なら -1 になる', () => {
    expect(percentageChange(0, 20)).toBe(-1);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/api -- src/lib/stats-range.test.ts`
Expected: FAIL。`Failed to resolve import "./stats-range"` で全 18 件が落ちる。

- [ ] **Step 3: stats-range.ts を実装する**

```ts
// apps/api/src/lib/stats-range.ts
// KPI グラフの日付バケット。月境界・年境界・うるう年で壊れやすいので純関数に切り出し、
// SQL とは独立にテストできるようにする。
import { addJstDays } from '@meshimap/core';
import type { JstDate } from '@meshimap/core';

/** 設計書 §5.2 の期間切替（7 / 30 / 90 日） */
export const STATS_RANGE_DAYS = [7, 30, 90] as const;
export type StatsRangeDays = (typeof STATS_RANGE_DAYS)[number];

export type DailyPoint = { readonly date: string; readonly value: number };

/** 末日を含む days 日ぶんの JST 日付を古い順に並べる */
export function buildDateKeys(endDate: JstDate, days: number): readonly JstDate[] {
  const keys: JstDate[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    keys.push(addJstDays(endDate, -offset));
  }
  return keys;
}

/** 集計結果には「0 件の日」の行が無いので、日付の並びに合わせて 0 を埋める。
 *  埋めないとグラフの点が詰まって、閲覧の無い日が無かったことになる */
export function fillDailySeries(
  keys: readonly JstDate[],
  rows: readonly { readonly date: string; readonly value: number }[],
): readonly DailyPoint[] {
  const byDate = new Map(rows.map((row) => [row.date, row.value]));
  return keys.map((date) => ({ date, value: byDate.get(date) ?? 0 }));
}

/** 前期間比。前期間が 0 のときは割れないので null を返す。
 *  0 を返すと「増減なし」と区別がつかなくなる */
export function percentageChange(current: number, previous: number): number | null {
  if (previous === 0) {
    return null;
  }
  return (current - previous) / previous;
}
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/api -- src/lib/stats-range.test.ts`
Expected: PASS（18 件）。

- [ ] **Step 5: 集計リポジトリの失敗するテストを書く**

```ts
// apps/api/src/repositories/shop-stats-repository.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMigratedD1 } from '../db/testing/local-d1';
import type { LocalD1 } from '../db/testing/local-d1';
import { createDatabase } from '../db/client';
import type { Database } from '../db/client';
import { seedTwoOwners } from './testing/owner-fixtures';
import type { OwnerFixture } from './testing/owner-fixtures';
import { loadShopStatsAsOwner, recordShopView } from './shop-stats-repository';

let local: LocalD1;
let db: Database;
let alice: OwnerFixture;
let bob: OwnerFixture;

/** JST 2026-09-15 の正午。UTC では 03:00 */
const NOW = new Date('2026-09-15T03:00:00Z');
/** JST 2026-09-15 の 00:30。UTC では前日 15:30 になるので、UTC 切りだと 9/14 に落ちる */
const JST_EARLY_MORNING = new Date('2026-09-14T15:30:00Z');

async function insertFavorite(userId: string, shopId: string, createdAt: Date): Promise<void> {
  await local.d1
    .prepare(
      `INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)`,
    )
    .bind(userId, `客${userId}`, `${userId}@example.com`)
    .run();
  await local.d1
    .prepare(`INSERT INTO favorites (user_id, shop_id, created_at) VALUES (?, ?, ?)`)
    .bind(userId, shopId, createdAt.getTime())
    .run();
}

beforeEach(async () => {
  local = await createMigratedD1();
  db = createDatabase(local.d1);
  const seeded = await seedTwoOwners(local);
  alice = seeded.alice;
  bob = seeded.bob;
});

afterEach(async () => {
  await local.dispose();
});

describe('recordShopView', () => {
  it('同じ日に 3 回記録すると view_count が 3 になる', async () => {
    await recordShopView(db, alice.shopId, NOW);
    await recordShopView(db, alice.shopId, NOW);
    await recordShopView(db, alice.shopId, NOW);
    const row = await local.d1
      .prepare(
        `SELECT view_count FROM shop_daily_stats WHERE shop_id = ? AND stats_date = '2026-09-15'`,
      )
      .bind(alice.shopId)
      .first<{ view_count: number }>();
    expect(row?.view_count).toBe(3);
  });

  it('JST 00:30 の閲覧は当日（9/15）に計上される（UTC 切りなら 9/14 になってしまう）', async () => {
    await recordShopView(db, alice.shopId, JST_EARLY_MORNING);
    const row = await local.d1
      .prepare(`SELECT stats_date FROM shop_daily_stats WHERE shop_id = ?`)
      .bind(alice.shopId)
      .first<{ stats_date: string }>();
    expect(row?.stats_date).toBe('2026-09-15');
  });

  it('日が変われば別の行になり、前日の値は維持される', async () => {
    await recordShopView(db, alice.shopId, new Date('2026-09-14T03:00:00Z'));
    await recordShopView(db, alice.shopId, NOW);
    const rows = await local.d1
      .prepare(
        `SELECT stats_date, view_count FROM shop_daily_stats WHERE shop_id = ? ORDER BY stats_date`,
      )
      .bind(alice.shopId)
      .all<{ stats_date: string; view_count: number }>();
    expect(rows.results).toEqual([
      { stats_date: '2026-09-14', view_count: 1 },
      { stats_date: '2026-09-15', view_count: 1 },
    ]);
  });

  it('存在しない店舗 ID でも例外を投げない（公開エンドポイントから呼ばれるため）', async () => {
    await expect(recordShopView(db, 'shp_nowhere', NOW)).resolves.toBeUndefined();
  });
});

describe('loadShopStatsAsOwner', () => {
  it('他人の店なら null を返す', async () => {
    expect(await loadShopStatsAsOwner(db, bob.actor, alice.shopId, 7, NOW)).toBeNull();
  });

  it('データが 1 件も無くても 7 日ぶんの点が全部 0 で返る（閲覧記録の配線前でも描画できる）', async () => {
    const stats = await loadShopStatsAsOwner(db, alice.actor, alice.shopId, 7, NOW);
    expect(stats?.views.points).toHaveLength(7);
    expect(stats?.views.points.every((point) => point.value === 0)).toBe(true);
    expect(stats?.views.total).toBe(0);
    expect(stats?.views.changeRate).toBeNull();
  });

  it('点の最終日が「今日」になる', async () => {
    const stats = await loadShopStatsAsOwner(db, alice.actor, alice.shopId, 7, NOW);
    expect(stats?.views.points[6]?.date).toBe('2026-09-15');
  });

  it('30 日・90 日を選ぶとその日数ぶんの点が返る', async () => {
    expect(
      (await loadShopStatsAsOwner(db, alice.actor, alice.shopId, 30, NOW))?.views.points,
    ).toHaveLength(30);
    expect(
      (await loadShopStatsAsOwner(db, alice.actor, alice.shopId, 90, NOW))?.views.points,
    ).toHaveLength(90);
  });

  it('閲覧数が日別に集計される', async () => {
    await recordShopView(db, alice.shopId, new Date('2026-09-14T03:00:00Z'));
    await recordShopView(db, alice.shopId, NOW);
    await recordShopView(db, alice.shopId, NOW);
    const stats = await loadShopStatsAsOwner(db, alice.actor, alice.shopId, 7, NOW);
    expect(stats?.views.points.map((point) => point.value)).toEqual([0, 0, 0, 0, 0, 1, 2]);
    expect(stats?.views.total).toBe(3);
  });

  it('保存数が favorites から日別に集計される', async () => {
    await insertFavorite('usr_fav1', alice.shopId, NOW);
    await insertFavorite('usr_fav2', alice.shopId, NOW);
    const stats = await loadShopStatsAsOwner(db, alice.actor, alice.shopId, 7, NOW);
    expect(stats?.favorites.total).toBe(2);
    expect(stats?.favorites.points[6]?.value).toBe(2);
  });

  it('他店の保存は混ざらない', async () => {
    await insertFavorite('usr_fav3', bob.shopId, NOW);
    const stats = await loadShopStatsAsOwner(db, alice.actor, alice.shopId, 7, NOW);
    expect(stats?.favorites.total).toBe(0);
  });

  it('前期間との比較が計算される（前 7 日に 2 件、今 7 日に 3 件 → +0.5）', async () => {
    // 前期間 = 9/2 〜 9/8、今期間 = 9/9 〜 9/15
    await recordShopView(db, alice.shopId, new Date('2026-09-05T03:00:00Z'));
    await recordShopView(db, alice.shopId, new Date('2026-09-06T03:00:00Z'));
    await recordShopView(db, alice.shopId, new Date('2026-09-13T03:00:00Z'));
    await recordShopView(db, alice.shopId, new Date('2026-09-14T03:00:00Z'));
    await recordShopView(db, alice.shopId, NOW);
    const stats = await loadShopStatsAsOwner(db, alice.actor, alice.shopId, 7, NOW);
    expect(stats?.views.total).toBe(3);
    expect(stats?.views.previousTotal).toBe(2);
    expect(stats?.views.changeRate).toBeCloseTo(0.5);
  });

  it('前期間が 0 件なら changeRate は null（0 ではない）', async () => {
    await recordShopView(db, alice.shopId, NOW);
    const stats = await loadShopStatsAsOwner(db, alice.actor, alice.shopId, 7, NOW);
    expect(stats?.views.previousTotal).toBe(0);
    expect(stats?.views.changeRate).toBeNull();
  });

  it('期間の 1 日前のデータは今期間に含まれない（境界）', async () => {
    // 7 日期間の開始は 9/9。9/8 は含まれない
    await recordShopView(db, alice.shopId, new Date('2026-09-08T03:00:00Z'));
    const stats = await loadShopStatsAsOwner(db, alice.actor, alice.shopId, 7, NOW);
    expect(stats?.views.total).toBe(0);
    expect(stats?.views.previousTotal).toBe(1);
  });

  it('期間の初日ちょうどのデータは今期間に含まれる（境界）', async () => {
    await recordShopView(db, alice.shopId, new Date('2026-09-09T03:00:00Z'));
    const stats = await loadShopStatsAsOwner(db, alice.actor, alice.shopId, 7, NOW);
    expect(stats?.views.total).toBe(1);
    expect(stats?.views.points[0]?.value).toBe(1);
  });
});
```

- [ ] **Step 6: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/api -- src/repositories/shop-stats-repository.test.ts`
Expected: FAIL。`Failed to resolve import "./shop-stats-repository"` で全 17 件が落ちる。

- [ ] **Step 7: 集計リポジトリを実装する**

```ts
// apps/api/src/repositories/shop-stats-repository.ts
// created_at は UTC のエポックミリ秒。UTC で日を切ると日本の 00:00〜09:00 が前日に落ち、
// オーナーが見る「昨日の予約数」が実感とズレる。+9 時間してから date() で切る。
import { and, between, eq, sql } from 'drizzle-orm';
import { toJstClock } from '@meshimap/core';
import type { JstDate, ShopId } from '@meshimap/core';

import type { OwnerActor } from '../auth/actor';
import type { Database } from '../db/client';
import { favorites, reservations, reviews, shopDailyStats } from '../db/schema';
import { buildDateKeys, fillDailySeries, percentageChange } from '../lib/stats-range';
import type { DailyPoint, StatsRangeDays } from '../lib/stats-range';
import { findOwnedShopId } from './owner-scope';

/** JST は UTC+9。9 * 60 * 60 * 1000 */
const JST_OFFSET_MILLISECONDS = 32_400_000;

export type MetricSeries = {
  readonly points: readonly DailyPoint[];
  readonly total: number;
  readonly previousTotal: number;
  readonly changeRate: number | null;
};

export type ShopStatsSummary = {
  readonly days: StatsRangeDays;
  readonly views: MetricSeries;
  readonly favorites: MetricSeries;
  readonly reservations: MetricSeries;
  readonly ratings: MetricSeries;
};

export async function recordShopView(db: Database, shopId: string, now: Date): Promise<void> {
  const statsDate = toJstClock(now).date;
  try {
    await db
      .insert(shopDailyStats)
      .values({ shopId, statsDate, viewCount: 1 })
      .onConflictDoUpdate({
        target: [shopDailyStats.shopId, shopDailyStats.statsDate],
        // 1 閲覧 1 行にすると人気店で行が無制限に伸びるので、日ごとに 1 行を加算する
        set: { viewCount: sql`${shopDailyStats.viewCount} + 1` },
      });
  } catch (error) {
    // 公開エンドポイントから呼ばれる。存在しない shopId は外部キー違反になるが、
    // 呼び出し側は常に 204 を返す（店舗 ID の存在有無を漏らさない）ので、ここで握る
    if (error instanceof Error && /FOREIGN KEY constraint failed/.test(error.message)) {
      return;
    }
    throw error;
  }
}

/** created_at（UTC ミリ秒）を JST の暦日文字列にする SQL 式 */
const jstDateExpression = (column: typeof favorites.createdAt) =>
  sql<string>`date((${column} + ${JST_OFFSET_MILLISECONDS}) / 1000, 'unixepoch')`;

function toSeries(
  keys: readonly JstDate[],
  rows: readonly { readonly date: string; readonly value: number }[],
  previousTotal: number,
): MetricSeries {
  const points = fillDailySeries(keys, rows);
  const total = points.reduce((sum, point) => sum + point.value, 0);
  return { points, total, previousTotal, changeRate: percentageChange(total, previousTotal) };
}

export async function loadShopStatsAsOwner(
  db: Database,
  actor: OwnerActor,
  shopId: ShopId,
  days: StatsRangeDays,
  now: Date,
): Promise<ShopStatsSummary | null> {
  const ownedShopId = await findOwnedShopId(db, actor, shopId);
  if (ownedShopId === null) {
    return null;
  }
  const today = toJstClock(now).date;
  const currentKeys = buildDateKeys(today, days);
  const previousKeys = buildDateKeys(currentKeys[0] ?? today, days + 1).slice(0, days);
  const currentFrom = currentKeys[0] ?? today;
  const previousFrom = previousKeys[0] ?? today;
  const previousTo = previousKeys[previousKeys.length - 1] ?? today;

  const viewRows = await db
    .select({ date: shopDailyStats.statsDate, value: shopDailyStats.viewCount })
    .from(shopDailyStats)
    .where(
      and(
        eq(shopDailyStats.shopId, ownedShopId),
        between(shopDailyStats.statsDate, previousFrom, today),
      ),
    );
  const currentViews = viewRows.filter((row) => row.date >= currentFrom);
  const previousViews = viewRows
    .filter((row) => row.date >= previousFrom && row.date <= previousTo)
    .reduce((sum, row) => sum + row.value, 0);

  const favoriteRows = await db
    .select({ date: jstDateExpression(favorites.createdAt), value: sql<number>`count(*)` })
    .from(favorites)
    .where(eq(favorites.shopId, ownedShopId))
    .groupBy(jstDateExpression(favorites.createdAt));
  const reservationRows = await db
    .select({ date: jstDateExpression(reservations.createdAt), value: sql<number>`count(*)` })
    .from(reservations)
    .where(eq(reservations.shopId, ownedShopId))
    .groupBy(jstDateExpression(reservations.createdAt));
  const ratingRows = await db
    .select({
      date: jstDateExpression(reviews.createdAt),
      value: sql<number>`avg(${reviews.rating})`,
    })
    .from(reviews)
    .where(eq(reviews.shopId, ownedShopId))
    .groupBy(jstDateExpression(reviews.createdAt));

  const inRange = (
    rows: readonly { readonly date: string; readonly value: number }[],
    from: string,
    to: string,
  ): readonly { readonly date: string; readonly value: number }[] =>
    rows.filter((row) => row.date >= from && row.date <= to);
  const sumOf = (rows: readonly { readonly value: number }[]): number =>
    rows.reduce((sum, row) => sum + row.value, 0);

  return {
    days,
    views: toSeries(currentKeys, currentViews, previousViews),
    favorites: toSeries(
      currentKeys,
      inRange(favoriteRows, currentFrom, today),
      sumOf(inRange(favoriteRows, previousFrom, previousTo)),
    ),
    reservations: toSeries(
      currentKeys,
      inRange(reservationRows, currentFrom, today),
      sumOf(inRange(reservationRows, previousFrom, previousTo)),
    ),
    ratings: toSeries(
      currentKeys,
      inRange(ratingRows, currentFrom, today),
      sumOf(inRange(ratingRows, previousFrom, previousTo)),
    ),
  };
}
```

**注意：** `ratings` だけは「合計」に意味が無い（評価の平均を足しても無意味）。`MetricSeries.total` の解釈が他の 3 指標と異なるので、**モバイル側の `KpiCard` は `ratings` について `total` ではなく「点が存在する日の平均」を表示する**（Task 8-16 で `averageOfPoints` を用意する）。この違いは Task 8-16 のコメントにも書く。

- [ ] **Step 8: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/api -- src/repositories/shop-stats-repository.test.ts`
Expected: PASS（17 件）。

- [ ] **Step 9: わざと壊して検証が効いていることを確認する**

`recordShopView` の `toJstClock(now).date` を、UTC 切りの実装に一時的に置き換える。

```ts
// 一時的な改悪
const statsDate = now.toISOString().slice(0, 10);
```

Run: `npm run test -w @meshimap/api -- src/repositories/shop-stats-repository.test.ts`
Expected: FAIL。「JST 00:30 の閲覧は当日（9/15）に計上される」が `expected '2026-09-14' to be '2026-09-15'` で落ちる。日本時間の深夜〜早朝の閲覧が丸ごと前日に流れる、という気づきにくい退行が捕まる。

次に `percentageChange` の `previous === 0` の分岐を `return 0` に変える。
Expected: FAIL（`src/lib/stats-range.test.ts` と `shop-stats-repository.test.ts` の両方）。「前期間が 0 なら null を返す」と「前期間が 0 件なら changeRate は null（0 ではない）」が `expected 0 to be null` で落ちる。

**両方確認したら元に戻し、再度テストが緑になることを確認する。**

- [ ] **Step 10: ミューテーションテストを実行する**

Run: `npm run test:mutation -w @meshimap/api`
Expected: スコア 85 以上。`buildDateKeys` の `offset = days - 1` → `days` や `offset >= 0` → `offset > 0` の変異は「末日を含む n 日ぶんを古い順に返す」「1 日ぶんなら末日だけを返す」が殺す。`inRange` の `>=` → `>` は「期間の初日ちょうどのデータは今期間に含まれる（境界）」が殺す。生き残った変異があれば殺せるテストを足す。**除外は選択肢にない。**

- [ ] **Step 11: コミット**

```bash
git add apps/api/src/lib/stats-range.ts apps/api/src/lib/stats-range.test.ts \
  apps/api/src/repositories/shop-stats-repository.ts apps/api/src/repositories/shop-stats-repository.test.ts
git commit -m "feat(api): KPI の日次集計と JST 基準の閲覧記録を追加"
```

---

## Task 8-12: 店舗申請（書類アップロード・再提出）リポジトリ

**Files:**

- Create: `apps/api/src/repositories/owner-application-repository.ts`
- Test: `apps/api/src/repositories/owner-application-repository.test.ts`

**Interfaces:**

- Consumes: `detectMediaType` / `buildApplicationDocumentKey` / `putMediaObject`（8-2）、`UPLOAD_MAX_BYTES` / `UPLOADABLE_DOCUMENT_MIME_TYPES`（8-2）、`applicationResubmitSchema`（8-3）、`shopApplications` / `ApplicationDocument`（既存スキーマ）、`APPLICATION_STATUSES`（api constants）、`seedTwoOwners`（8-4）
- Produces:
  - `type ShopApplicationRow = typeof shopApplications.$inferSelect`
  - `type DocumentUploadResult = { readonly ok: true; readonly application: ShopApplicationRow } | { readonly ok: false; readonly reason: 'too-large' | 'unsupported-type' | 'not-returned' }`
  - `async function findLatestApplicationAsOwner(db, actor): Promise<ShopApplicationRow | null>`
  - `async function appendApplicationDocumentAsOwner(db, bucket, actor, uuid: string, kind: string, body: ArrayBuffer): Promise<DocumentUploadResult | null>`
  - `async function resubmitApplicationAsOwner(db, actor, note: string, _now: Date): Promise<ShopApplicationRow | null>`（`shop_applications` に `updated_at` 列が無いので `_now` は使わない。呼び出し側の形を他のリポジトリと揃えるためだけに残す）

### 所有権の鍵が `applicant_id` になる

申請だけは店舗を経由しない。`shop_applications.applicant_id = actor.userId` が所有権の表現である。形は同じ（SQL の `WHERE`）だが、鍵になる列が違う点に注意する。

### 再提出できるのは `returned` のときだけ

`APPLICATION_STATUSES` は `['pending', 'approved', 'rejected', 'returned']`。「差し戻し（returned）」は「書類を直して出し直してください」という状態で、ここからだけ `pending` に戻せる。`rejected`（却下）や `approved`（承認済み）から `pending` に戻せると、審査結果を申請者が自分でひっくり返せてしまう。この分岐は `WHERE status = 'returned'` として SQL に埋め、更新行数 0 で弾く。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// apps/api/src/repositories/owner-application-repository.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UPLOAD_MAX_BYTES } from '@meshimap/core';

import { createMigratedD1 } from '../db/testing/local-d1';
import type { LocalD1 } from '../db/testing/local-d1';
import { createDatabase } from '../db/client';
import type { Database } from '../db/client';
import { seedTwoOwners } from './testing/owner-fixtures';
import type { OwnerFixture } from './testing/owner-fixtures';
import {
  appendApplicationDocumentAsOwner,
  findLatestApplicationAsOwner,
  resubmitApplicationAsOwner,
} from './owner-application-repository';

let local: LocalD1;
let db: Database;
let alice: OwnerFixture;
let bob: OwnerFixture;

const NOW = new Date('2026-09-15T03:00:00Z');

function pdfBytes(totalLength: number): ArrayBuffer {
  const bytes = new Uint8Array(totalLength);
  bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0);
  return bytes.buffer;
}

async function insertApplication(
  id: string,
  applicantId: string,
  status: string,
  createdAt: number,
): Promise<void> {
  // shop_applications.shop_id は NOT NULL で shops.id を参照する（apps/api/src/db/schema/admin.ts:112-114）。
  // NULL を bind すると外部キー以前に NOT NULL 制約で落ちるので、申請者が持つ店舗を引いて埋める。
  // updated_at 列はこの表に無い（同 105-128）
  const shop = await local.d1
    .prepare('SELECT id FROM shops WHERE owner_id = ? LIMIT 1')
    .bind(applicantId)
    .first<{ id: string }>();
  if (shop === null) {
    throw new Error(`${applicantId} の店舗が seed されていない`);
  }
  await local.d1
    .prepare(
      `INSERT INTO shop_applications (id, applicant_id, shop_id, status, documents, review_note, created_at)
       VALUES (?, ?, ?, ?, '[]', ?, ?)`,
    )
    .bind(
      id,
      applicantId,
      shop.id,
      status,
      status === 'returned' ? '営業許可証が不鮮明です' : null,
      createdAt,
    )
    .run();
}

beforeEach(async () => {
  local = await createMigratedD1();
  db = createDatabase(local.d1);
  const seeded = await seedTwoOwners(local);
  alice = seeded.alice;
  bob = seeded.bob;
});

afterEach(async () => {
  await local.dispose();
});

describe('findLatestApplicationAsOwner', () => {
  it('申請が無ければ null を返す', async () => {
    expect(await findLatestApplicationAsOwner(db, alice.actor)).toBeNull();
  });

  it('自分の最新の申請を返す', async () => {
    await insertApplication('app_old', alice.userId, 'rejected', 1000);
    await insertApplication('app_new', alice.userId, 'returned', 2000);
    expect((await findLatestApplicationAsOwner(db, alice.actor))?.id).toBe('app_new');
  });

  it('他人の申請は見えない', async () => {
    await insertApplication('app_bob', bob.userId, 'pending', 1000);
    expect(await findLatestApplicationAsOwner(db, alice.actor)).toBeNull();
  });

  it('差し戻し理由（review_note）が読める', async () => {
    await insertApplication('app_r', alice.userId, 'returned', 1000);
    expect((await findLatestApplicationAsOwner(db, alice.actor))?.reviewNote).toBe(
      '営業許可証が不鮮明です',
    );
  });
});

describe('appendApplicationDocumentAsOwner', () => {
  beforeEach(async () => {
    await insertApplication('app_doc', alice.userId, 'returned', 1000);
  });

  it('PDF を追加すると R2 に置かれ、documents に 1 件増える', async () => {
    const result = await appendApplicationDocumentAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      'doc1',
      'business-license',
      pdfBytes(64),
    );
    expect(result?.ok).toBe(true);
    expect(result?.ok === true && result.application.documents).toHaveLength(1);
    expect(await local.mediaBucket.get('application-documents/usr_alice/doc1.pdf')).not.toBeNull();
  });

  it('2 件目を追加すると documents が 2 件になる（上書きしない）', async () => {
    await appendApplicationDocumentAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      'doc1',
      'business-license',
      pdfBytes(64),
    );
    const result = await appendApplicationDocumentAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      'doc2',
      'food-hygiene',
      pdfBytes(64),
    );
    expect(result?.ok === true && result.application.documents.map((doc) => doc.kind)).toEqual([
      'business-license',
      'food-hygiene',
    ]);
  });

  it('上限を 1 バイト超えたら too-large で拒否し、R2 に何も置かない', async () => {
    const result = await appendApplicationDocumentAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      'doc3',
      'business-license',
      pdfBytes(UPLOAD_MAX_BYTES + 1),
    );
    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(await local.mediaBucket.get('application-documents/usr_alice/doc3.pdf')).toBeNull();
  });

  it('WebP は書類として受け付けない（PDF / JPEG / PNG のみ）', async () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]).buffer;
    const result = await appendApplicationDocumentAsOwner(
      db,
      local.mediaBucket,
      alice.actor,
      'doc4',
      'business-license',
      webp,
    );
    expect(result).toEqual({ ok: false, reason: 'unsupported-type' });
  });

  it('申請が 1 件も無ければ null を返す', async () => {
    await local.d1.prepare(`DELETE FROM shop_applications`).run();
    expect(
      await appendApplicationDocumentAsOwner(
        db,
        local.mediaBucket,
        alice.actor,
        'doc5',
        'x',
        pdfBytes(64),
      ),
    ).toBeNull();
  });

  it('他人の申請には書類を足せない', async () => {
    expect(
      await appendApplicationDocumentAsOwner(
        db,
        local.mediaBucket,
        bob.actor,
        'doc6',
        'x',
        pdfBytes(64),
      ),
    ).toBeNull();
    const row = await local.d1
      .prepare(`SELECT documents FROM shop_applications WHERE id = 'app_doc'`)
      .first<{ documents: string }>();
    expect(row?.documents).toBe('[]');
  });
});

describe('resubmitApplicationAsOwner', () => {
  it('returned なら pending に戻せる', async () => {
    await insertApplication('app_ok', alice.userId, 'returned', 1000);
    const resubmitted = await resubmitApplicationAsOwner(
      db,
      alice.actor,
      '書類を差し替えました',
      NOW,
    );
    expect(resubmitted?.status).toBe('pending');
  });

  it('rejected からは再提出できない（審査結果を覆せない）', async () => {
    await insertApplication('app_rej', alice.userId, 'rejected', 1000);
    expect(await resubmitApplicationAsOwner(db, alice.actor, '再挑戦', NOW)).toBeNull();
    const row = await local.d1
      .prepare(`SELECT status FROM shop_applications WHERE id = 'app_rej'`)
      .first<{ status: string }>();
    expect(row?.status).toBe('rejected');
  });

  it('approved からは再提出できない', async () => {
    await insertApplication('app_app', alice.userId, 'approved', 1000);
    expect(await resubmitApplicationAsOwner(db, alice.actor, '再挑戦', NOW)).toBeNull();
  });

  it('pending からは再提出できない（二重提出を防ぐ）', async () => {
    await insertApplication('app_pen', alice.userId, 'pending', 1000);
    expect(await resubmitApplicationAsOwner(db, alice.actor, '再挑戦', NOW)).toBeNull();
  });

  it('他人の returned 申請は再提出できない', async () => {
    await insertApplication('app_bob_ret', bob.userId, 'returned', 1000);
    expect(await resubmitApplicationAsOwner(db, alice.actor, '横取り', NOW)).toBeNull();
    const row = await local.d1
      .prepare(`SELECT status FROM shop_applications WHERE id = 'app_bob_ret'`)
      .first<{ status: string }>();
    expect(row?.status).toBe('returned');
  });

  it('申請が無ければ null を返す', async () => {
    expect(await resubmitApplicationAsOwner(db, alice.actor, 'なにもない', NOW)).toBeNull();
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/api -- src/repositories/owner-application-repository.test.ts`
Expected: FAIL。`Failed to resolve import "./owner-application-repository"` で全 17 件が落ちる。

- [ ] **Step 3: リポジトリを実装する**

```ts
// apps/api/src/repositories/owner-application-repository.ts
// 申請だけは店舗を経由しない。所有権の鍵は applicant_id。
// 再提出できるのは returned のときだけで、その条件は WHERE に埋めて更新行数 0 で弾く
// （アプリ層の if にすると、条件を読んでから書くまでの間に状態が変わりうる）。
import { and, desc, eq } from 'drizzle-orm';
import { UPLOAD_MAX_BYTES, UPLOADABLE_DOCUMENT_MIME_TYPES } from '@meshimap/core';

import type { OwnerActor } from '../auth/actor';
import type { Database } from '../db/client';
import { shopApplications } from '../db/schema';
import type { ApplicationDocument } from '../db/schema/admin';
import { buildApplicationDocumentKey, detectMediaType, putMediaObject } from '../lib/media';

export type ShopApplicationRow = typeof shopApplications.$inferSelect;
export type DocumentUploadResult =
  | { readonly ok: true; readonly application: ShopApplicationRow }
  | { readonly ok: false; readonly reason: 'too-large' | 'unsupported-type' };

const APPLICATION_STATUS_PENDING = 'pending';
const APPLICATION_STATUS_RETURNED = 'returned';

export async function findLatestApplicationAsOwner(
  db: Database,
  actor: OwnerActor,
): Promise<ShopApplicationRow | null> {
  const rows = await db
    .select()
    .from(shopApplications)
    .where(eq(shopApplications.applicantId, actor.userId))
    .orderBy(desc(shopApplications.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function appendApplicationDocumentAsOwner(
  db: Database,
  bucket: R2Bucket,
  actor: OwnerActor,
  uuid: string,
  kind: string,
  body: ArrayBuffer,
): Promise<DocumentUploadResult | null> {
  const application = await findLatestApplicationAsOwner(db, actor);
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
      and(eq(shopApplications.id, application.id), eq(shopApplications.applicantId, actor.userId)),
    )
    .returning();
  const row = updated[0];
  return row === undefined ? null : { ok: true, application: row };
}

export async function resubmitApplicationAsOwner(
  db: Database,
  actor: OwnerActor,
  note: string,
  // shop_applications に updated_at 列は無い（apps/api/src/db/schema/admin.ts:105-128）。
  // 引数を消すと呼び出し側 8 箇所が一斉に変わるので、`_` を付けて未使用のまま残す
  // （`createShopAsAdmin(db, _actor, ...)` と同じ書き方で lint を通る）
  _now: Date,
): Promise<ShopApplicationRow | null> {
  const application = await findLatestApplicationAsOwner(db, actor);
  if (application === null) {
    return null;
  }
  const updated = await db
    .update(shopApplications)
    .set({ status: APPLICATION_STATUS_PENDING, reviewNote: note })
    .where(
      and(
        eq(shopApplications.id, application.id),
        eq(shopApplications.applicantId, actor.userId),
        // rejected / approved / pending からは戻せない。審査結果を申請者が覆せないようにする
        eq(shopApplications.status, APPLICATION_STATUS_RETURNED),
      ),
    )
    .returning();
  return updated[0] ?? null;
}
```

**注意（2026-09-16 訂正）：** `uq_shop_applications_shop_pending` は `WHERE status = 'pending'` の部分ユニーク索引で、同じ店に 2 本の pending が並ばないことを保証する。**`shop_id` は `.notNull()` なので「NULL のままなので影響を受けない」は誤りだった**（`apps/api/src/db/schema/admin.ts:112-114` で実測）。Phase 8 が扱う再提出は**既存の申請行を UPDATE するだけで新しい行を作らない**ので、索引の対象は常に 1 行のまま増えない。初回申請（Phase 9 Task 9-25）も同様に、`returned` からの再提出では行を増やさない設計にしてある。

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/api -- src/repositories/owner-application-repository.test.ts`
Expected: PASS（17 件）。

- [ ] **Step 5: わざと壊して検証が効いていることを確認する**

`resubmitApplicationAsOwner` の `where` から `eq(shopApplications.status, APPLICATION_STATUS_RETURNED)` を一時的に外す。

Run: `npm run test -w @meshimap/api -- src/repositories/owner-application-repository.test.ts`
Expected: FAIL。「rejected からは再提出できない（審査結果を覆せない）」「approved からは再提出できない」「pending からは再提出できない（二重提出を防ぐ）」の 3 件が落ちる。却下された申請者が自分で審査状態を `pending` に戻せるという、業務上重大な穴が検出される。

次に `appendApplicationDocumentAsOwner` の `nextDocuments` を `[{ kind, r2Key: key }]`（既存を捨てる）に変える。
Expected: FAIL。「2 件目を追加すると documents が 2 件になる（上書きしない）」が `expected ['food-hygiene'] to equal ['business-license', 'food-hygiene']` で落ちる。

**両方確認したら元に戻し、再度テストが緑になることを確認する。**

- [ ] **Step 6: コミット**

```bash
git add apps/api/src/repositories/owner-application-repository.ts apps/api/src/repositories/owner-application-repository.test.ts
git commit -m "feat(api): 店舗申請の書類追加と returned からの再提出を追加"
```

---

## Task 8-13: `/owner` サブアプリ基盤と店舗・営業時間・座席・写真ルート

**Files:**

- Create: `apps/api/src/lib/entity-id.ts`
- Create: `apps/api/src/lib/entity-id.test.ts`
- Create: `apps/api/src/routes/owner/guard.ts`
- Create: `apps/api/src/routes/owner/index.ts`
- Create: `apps/api/src/routes/owner/shop-routes.ts`
- Create: `apps/api/src/routes/owner/photo-routes.ts`
- Create: `apps/api/src/routes/testing/owner-app.ts`
- Modify: `apps/api/src/lib/stats-range.ts`（`parseStatsRangeDays` を追加）
- Modify: `apps/api/src/lib/stats-range.test.ts`（同上のテストを追加）
- Modify: `apps/api/src/repositories/owner-scope.ts`（`listOwnedShops` を追加）
- Modify: `apps/api/src/repositories/owner-scope.test.ts`（同上のテストを追加）
- Test: `apps/api/src/routes/owner/guard.test.ts`
- Test: `apps/api/src/routes/owner/shop-routes.test.ts`
- Test: `apps/api/src/routes/owner/photo-routes.test.ts`

**Interfaces:**

- Consumes: `isAuthenticatedActor` / `isOwnerActor` / `Viewer` / `OwnerActor`（`src/auth/actor.ts`、実ファイルで確認済み）、`AppBindings` / `AppVariables` / `AppEnv`（`src/lib/app-env.ts`、実ファイルで確認済み）、`unauthorized` / `forbidden` / `notFound` / `invalidInput`（`src/lib/http-error.ts`、実ファイルで確認済み。**`invalidInput()` は 422 を返す**）、`errorHandler` / `notFoundHandler`（`src/middleware/error-handler.ts`）、`createDatabase`（`src/db/client.ts`）、`toShopId`（core）、Task 8-5 / 8-6 / 8-8 / 8-11 の各リポジトリ関数
- Produces:
  - `src/lib/entity-id.ts`:
    - `const ENTITY_ID_PREFIXES = { shopHour: 'shh', shopClosure: 'shc', shopPhoto: 'pht', menuCategory: 'mnc', menuItem: 'mni', campaign: 'cmp', report: 'rpt', applicationDocument: 'apd' } as const`
    - `type EntityKind = keyof typeof ENTITY_ID_PREFIXES`
    - `function createUuidHex(): string`（`crypto.randomUUID()` からハイフンを除いた 32 桁の小文字 16 進）
    - `function buildEntityId(kind: EntityKind, uuidHex: string): string`
  - `src/lib/stats-range.ts` に追加: `function parseStatsRangeDays(raw: string | undefined): StatsRangeDays | null`
  - `src/repositories/owner-scope.ts` に追加:
    - `type OwnedShopSummary = { readonly id: ShopId; readonly name: string; readonly status: string; readonly ratingAvg: number; readonly ratingCount: number }`
    - `async function listOwnedShops(db: Database, actor: OwnerActor): Promise<readonly OwnedShopSummary[]>`
  - `src/routes/owner/guard.ts`:
    - `type OwnerEnv = { Bindings: AppBindings; Variables: AppVariables & { readonly owner: OwnerActor } }`
    - `const requireOwner: MiddlewareHandler<OwnerEnv>`
    - `function readShopIdParam(c: Context<OwnerEnv>): ShopId`
    - `function readIdParam(c: Context<OwnerEnv>, name: string): string`
    - `async function readJsonBody<TValue>(c: Context<OwnerEnv>, schema: ZodType<TValue>): Promise<TValue>`
    - `function requireOwned<TValue>(value: TValue | null): TValue`
  - `src/routes/owner/index.ts`: `const ownerRoutes: Hono<OwnerEnv>`
  - `src/routes/testing/owner-app.ts`: `function createOwnerTestApp(local: LocalD1, viewer: Viewer): { readonly request: (path: string, init?: RequestInit) => Promise<Response> }`

### なぜサブアプリを分けるのか

`roleGuard` を各ハンドラに書くと、書き忘れが 1 箇所あるだけで穴が開く。`/owner/**` をサブアプリにし、`requireOwner` をその入り口に 1 回だけ掛ければ、**ハンドラ側に権限判定のコードが 1 行も残らない**。書き忘れようがない。

`Hono` の `route()` のシグネチャは `route<SubPath extends string, SubEnv extends Env, ...>(path, app: Hono<SubEnv, ...>)`（`node_modules/hono/dist/types/hono-base.d.ts:96` で確認）であり、サブアプリの `Env` は親の `Env` に代入可能であればよい。`OwnerEnv` は `AppEnv` の `Variables` に `owner` を足しただけなので構造的に代入可能である。つまり「`owner` が必ず入っている」という事実を**型で**サブアプリの内側だけに閉じ込められる。

### なぜ `c.get('owner')` を使い、ハンドラで再度 `isOwnerActor` を呼ばないのか

再チェックを書くと、その分岐は**絶対に false にならない**（ミドルウェアが通した後だから）。到達不能なコードはミューテーションテストで必ず生き残り、「テストを足しても殺せない」状態になる。生き残った変異への対応 3 択のうち「到達できる形に書き直す」を先回りして適用し、そもそも到達不能な分岐を作らない。

### 不正な形式の ID を 404 にする理由

`toShopId('shp_あ')` は例外を投げる。ここで 422 を返すと「形式が正しい ID」と「形式が不正な ID」が応答で区別でき、総当たりの手掛かりになる。`/owner/**` では**形式不正も所有していないのも等しく 404** に畳む。`invalidInput()`（422）を使うのは**本文**の検証失敗だけである。

### アップロードの受け口は `multipart/form-data`

Expo / React Native の標準的なアップロード手段は `FormData` に `{ uri, name, type }` を渡す形である。Workers ランタイムは `Request#formData()` を持ち（`@cloudflare/workers-types/index.d.ts:2037`）、`File` クラスも定義されている（同 :1198）ので、Worker 側は追加ライブラリなしで受けられる。クライアントが申告する `type` は**一切信用せず**、`file.arrayBuffer()` の先頭バイトを `detectMediaType` で判定する（Task 8-2）。

**未確認：** React Native 実機で `FormData` にファイル URI を渡したときの挙動は、このリポジトリからは検証できない。Worker 側の受け口は miniflare 上のテストで検証する。

- [ ] **Step 1: entity-id の失敗するテストを書く**

```ts
// apps/api/src/lib/entity-id.test.ts
import { describe, expect, it } from 'vitest';
import { IDENTIFIER_MAX_LENGTH, IDENTIFIER_PATTERN } from '@meshimap/core';

import { buildEntityId, createUuidHex, ENTITY_ID_PREFIXES } from './entity-id';

describe('createUuidHex', () => {
  it('32 桁の小文字 16 進を返す', () => {
    expect(createUuidHex()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('呼ぶたびに違う値を返す', () => {
    expect(createUuidHex()).not.toBe(createUuidHex());
  });
});

describe('buildEntityId', () => {
  const uuidHex = 'abcdef0123456789abcdef0123456789';

  it('種別ごとの接頭辞を付ける', () => {
    expect(buildEntityId('shopPhoto', uuidHex)).toBe(`pht_${uuidHex}`);
    expect(buildEntityId('menuItem', uuidHex)).toBe(`mni_${uuidHex}`);
  });

  it('接頭辞は seeds/seed.sql の既存 ID と同じ 3 文字にそろえる', () => {
    expect(ENTITY_ID_PREFIXES.shopHour).toBe('shh');
    expect(ENTITY_ID_PREFIXES.menuCategory).toBe('mnc');
    expect(ENTITY_ID_PREFIXES.menuItem).toBe('mni');
    expect(Object.values(ENTITY_ID_PREFIXES).every((prefix) => prefix.length === 3)).toBe(true);
  });

  it('生成した ID は IDENTIFIER_PATTERN を満たす', () => {
    for (const kind of Object.keys(ENTITY_ID_PREFIXES)) {
      expect(buildEntityId(kind as keyof typeof ENTITY_ID_PREFIXES, uuidHex)).toMatch(
        IDENTIFIER_PATTERN,
      );
    }
  });

  it('生成した ID は IDENTIFIER_MAX_LENGTH を超えない（36 文字）', () => {
    expect(buildEntityId('campaign', uuidHex).length).toBe(36);
    expect(buildEntityId('campaign', uuidHex).length).toBeLessThanOrEqual(IDENTIFIER_MAX_LENGTH);
  });

  it('生成した ID は小文字だけなので R2 キーにそのまま埋め込める', () => {
    expect(buildEntityId('shopPhoto', createUuidHex())).toMatch(/^[a-z0-9_]+$/);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/api -- src/lib/entity-id.test.ts`
Expected: FAIL。`Failed to resolve import "./entity-id"` で全 7 件が落ちる。

- [ ] **Step 3: entity-id.ts を実装する**

```ts
// apps/api/src/lib/entity-id.ts
// ID の接頭辞は seeds/seed.sql の既存値（shh_ / mnc_ / mni_ / rvw_ / shp_ / usr_）に合わせる。
// 揃えないと、シードで作ったデータとアプリで作ったデータが目視で区別できてしまい、
// 「本番でだけ起きるバグ」を再現するときに邪魔になる。
export const ENTITY_ID_PREFIXES = {
  shopHour: 'shh',
  shopClosure: 'shc',
  shopPhoto: 'pht',
  menuCategory: 'mnc',
  menuItem: 'mni',
  campaign: 'cmp',
  report: 'rpt',
  applicationDocument: 'apd',
} as const;

export type EntityKind = keyof typeof ENTITY_ID_PREFIXES;

/**
 * ハイフンを除いた 32 桁の小文字 16 進。
 * ハイフンを残すと R2 キーには使えるが ID として読みにくく、
 * 逆に大文字にすると r2_key の CHECK（consistsOf 'a-z0-9/._-'）に引っかかる。
 */
export function createUuidHex(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

export function buildEntityId(kind: EntityKind, uuidHex: string): string {
  return `${ENTITY_ID_PREFIXES[kind]}_${uuidHex}`;
}
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/api -- src/lib/entity-id.test.ts`
Expected: PASS（7 件）。

- [ ] **Step 5: `parseStatsRangeDays` と `listOwnedShops` の失敗するテストを書く**

```ts
// apps/api/src/lib/stats-range.test.ts に追記
import { parseStatsRangeDays } from './stats-range';

describe('parseStatsRangeDays', () => {
  it('未指定なら既定の 7 を返す', () => {
    expect(parseStatsRangeDays(undefined)).toBe(7);
  });

  it('許可された値はそのまま数値で返す', () => {
    expect(parseStatsRangeDays('7')).toBe(7);
    expect(parseStatsRangeDays('30')).toBe(30);
    expect(parseStatsRangeDays('90')).toBe(90);
  });

  it('許可されていない数値は null を返す（365 日ぶんの集計で CPU 時間を使わせない）', () => {
    expect(parseStatsRangeDays('365')).toBeNull();
    expect(parseStatsRangeDays('0')).toBeNull();
    expect(parseStatsRangeDays('-7')).toBeNull();
  });

  it('数値でない文字列は null を返す', () => {
    expect(parseStatsRangeDays('７')).toBeNull();
    expect(parseStatsRangeDays('seven')).toBeNull();
    expect(parseStatsRangeDays('')).toBeNull();
  });

  it('前後に空白がある値は受け付けない（曖昧な入力を通さない）', () => {
    expect(parseStatsRangeDays(' 7 ')).toBeNull();
  });
});
```

```ts
// apps/api/src/repositories/owner-scope.test.ts に追記
import { listOwnedShops } from './owner-scope';

describe('listOwnedShops', () => {
  it('自分の店だけを返す', async () => {
    const shops = await listOwnedShops(db, alice.actor);
    expect(shops.map((shop) => shop.id)).toEqual([alice.shopId]);
  });

  it('他人の店は 1 件も含まれない', async () => {
    const shops = await listOwnedShops(db, bob.actor);
    expect(shops.some((shop) => shop.id === alice.shopId)).toBe(false);
  });

  it('店を持たないオーナーには空配列を返す（null ではない）', async () => {
    await local.d1
      .prepare(`UPDATE shops SET owner_id = NULL WHERE owner_id = ?`)
      .bind(alice.userId)
      .run();
    expect(await listOwnedShops(db, alice.actor)).toEqual([]);
  });

  it('一覧に必要な列（名称・状態・評価）が入っている', async () => {
    const shops = await listOwnedShops(db, alice.actor);
    expect(shops[0]).toMatchObject({ id: alice.shopId, status: 'published' });
    expect(typeof shops[0]?.name).toBe('string');
    expect(typeof shops[0]?.ratingAvg).toBe('number');
    expect(typeof shops[0]?.ratingCount).toBe('number');
  });
});
```

- [ ] **Step 6: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/api -- src/lib/stats-range.test.ts src/repositories/owner-scope.test.ts`
Expected: FAIL。`parseStatsRangeDays is not a function` と `listOwnedShops is not a function` で計 9 件が落ちる。

- [ ] **Step 7: 2 つの関数を追加する**

```ts
// apps/api/src/lib/stats-range.ts に追記
/** 期間の既定値。ダッシュボードを開いた直後に出す範囲 */
const DEFAULT_STATS_RANGE_DAYS: StatsRangeDays = 7;

/**
 * クエリ文字列を期間に変換する。許可値以外は null。
 * 任意の日数を通すと 365 日 × 4 指標の集計で Worker の CPU 時間を使い切れてしまう。
 * 数値化に Number() ではなく完全一致を使うのは、' 7 ' や '7.0' を通さないため。
 */
export function parseStatsRangeDays(raw: string | undefined): StatsRangeDays | null {
  if (raw === undefined) {
    return DEFAULT_STATS_RANGE_DAYS;
  }
  return STATS_RANGE_DAYS.find((days) => String(days) === raw) ?? null;
}
```

```ts
// apps/api/src/repositories/owner-scope.ts に追記
export type OwnedShopSummary = {
  readonly id: ShopId;
  readonly name: string;
  readonly status: string;
  readonly ratingAvg: number;
  readonly ratingCount: number;
};

/**
 * オーナーの店舗一覧。所有権は WHERE owner_id = ? がすべてで、
 * 取得後にアプリ層で絞る処理は一切ない（絞り忘れの余地を作らない）。
 */
export async function listOwnedShops(
  db: Database,
  actor: OwnerActor,
): Promise<readonly OwnedShopSummary[]> {
  const rows = await db
    .select({
      id: shops.id,
      name: shops.name,
      status: shops.status,
      ratingAvg: shops.ratingAvg,
      ratingCount: shops.ratingCount,
    })
    .from(shops)
    .where(eq(shops.ownerId, actor.userId))
    .orderBy(shops.name);
  return rows.map((row) => ({ ...row, id: toShopId(row.id) }));
}
```

- [ ] **Step 8: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/api -- src/lib/stats-range.test.ts src/repositories/owner-scope.test.ts`
Expected: PASS（`stats-range` 23 件、`owner-scope` は Task 8-4 の件数 + 4 件）。

- [ ] **Step 9: コミット**

```bash
git add apps/api/src/lib/entity-id.ts apps/api/src/lib/entity-id.test.ts \
  apps/api/src/lib/stats-range.ts apps/api/src/lib/stats-range.test.ts \
  apps/api/src/repositories/owner-scope.ts apps/api/src/repositories/owner-scope.test.ts
git commit -m "feat(api): ID 生成・期間パラメータ解釈・所有店舗一覧を追加"
```

- [ ] **Step 10: ガードの失敗するテストを書く**

```ts
// apps/api/src/routes/owner/guard.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ANONYMOUS_VIEWER, toActor } from '../../auth/actor';
import { createMigratedD1 } from '../../db/testing/local-d1';
import type { LocalD1 } from '../../db/testing/local-d1';
import { seedTwoOwners } from '../../repositories/testing/owner-fixtures';
import {
  ERROR_MESSAGE_FORBIDDEN,
  ERROR_MESSAGE_NOT_FOUND,
  ERROR_MESSAGE_UNAUTHORIZED,
} from '../../lib/http-error';
import { createOwnerTestApp } from '../testing/owner-app';

let local: LocalD1;

beforeEach(async () => {
  local = await createMigratedD1();
  await seedTwoOwners(local);
});

afterEach(async () => {
  await local.dispose();
});

describe('requireOwner', () => {
  it('未認証は 401 を返す', async () => {
    const response = await createOwnerTestApp(local, ANONYMOUS_VIEWER).request('/owner/shops');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { status: 401, message: ERROR_MESSAGE_UNAUTHORIZED },
    });
  });

  it('一般利用者は 403 を返す', async () => {
    const response = await createOwnerTestApp(local, toActor('usr_alice', 'user')).request(
      '/owner/shops',
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { status: 403, message: ERROR_MESSAGE_FORBIDDEN },
    });
  });

  it('システム管理者も 403 を返す（店舗管理は所有者だけの経路）', async () => {
    const response = await createOwnerTestApp(local, toActor('usr_alice', 'admin')).request(
      '/owner/shops',
    );
    expect(response.status).toBe(403);
  });

  it('オーナーは 200 を返す', async () => {
    const response = await createOwnerTestApp(local, toActor('usr_alice', 'owner')).request(
      '/owner/shops',
    );
    expect(response.status).toBe(200);
  });

  it('未認証のとき、存在する店舗 ID でも存在しない店舗 ID でも同じ 401 になる（存在有無が漏れない）', async () => {
    const app = createOwnerTestApp(local, ANONYMOUS_VIEWER);
    const existing = await app.request('/owner/shops/shp_alice/seats');
    const missing = await app.request('/owner/shops/shp_nowhere/seats');
    expect(existing.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(await existing.json()).toEqual(await missing.json());
  });

  it('一般利用者のとき、自分が作ったわけでもない店舗 ID でも 403 で止まり 404 にはならない（役割判定が ID より先）', async () => {
    const response = await createOwnerTestApp(local, toActor('usr_bob', 'user')).request(
      '/owner/shops/shp_nowhere/seats',
    );
    expect(response.status).toBe(403);
  });

  it('形式が不正な店舗 ID は 422 ではなく 404 になる（形式の正誤が漏れない）', async () => {
    const response = await createOwnerTestApp(local, toActor('usr_alice', 'owner')).request(
      `/owner/shops/${encodeURIComponent('shp_あ')}/seats`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { status: 404, message: ERROR_MESSAGE_NOT_FOUND },
    });
  });

  it('他人の店は 404 になり、応答本文は存在しない店と 1 バイトも違わない', async () => {
    const app = createOwnerTestApp(local, toActor('usr_bob', 'owner'));
    const others = await app.request('/owner/shops/shp_alice/seats');
    const missing = await app.request('/owner/shops/shp_nowhere/seats');
    expect(others.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await others.text()).toBe(await missing.text());
  });
});
```

- [ ] **Step 11: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/api -- src/routes/owner/guard.test.ts`
Expected: FAIL。`Failed to resolve import "../testing/owner-app"` で全 8 件が落ちる。

- [ ] **Step 12: ガードとテスト用アプリを実装する**

```ts
// apps/api/src/routes/owner/guard.ts
import { createMiddleware } from 'hono/factory';
import { toShopId } from '@meshimap/core';
import type { ShopId } from '@meshimap/core';
import type { Context, MiddlewareHandler } from 'hono';
import type { ZodType } from 'zod';

import { isAuthenticatedActor, isOwnerActor } from '../../auth/actor';
import type { OwnerActor } from '../../auth/actor';
import type { AppBindings, AppVariables } from '../../lib/app-env';
import { forbidden, invalidInput, notFound, unauthorized } from '../../lib/http-error';

/**
 * /owner 配下だけの環境型。
 * Variables に owner を足すことで「ここでは owner が必ず入っている」を型で表せる。
 * ハンドラ側に isOwnerActor の再チェックを書かずに済み、到達不能な分岐が生まれない。
 */
export type OwnerEnv = {
  Bindings: AppBindings;
  Variables: AppVariables & { readonly owner: OwnerActor };
};

/**
 * /owner 配下で唯一の権限判定。
 * リソース ID を読む前に判定が終わるので、403（役割）と 404（所有）が物理的に分かれる。
 */
export const requireOwner: MiddlewareHandler<OwnerEnv> = createMiddleware<OwnerEnv>(
  async (c, next) => {
    const viewer = c.get('viewer');
    if (!isAuthenticatedActor(viewer)) {
      throw unauthorized();
    }
    if (!isOwnerActor(viewer)) {
      throw forbidden();
    }
    c.set('owner', viewer);
    await next();
  },
);

/**
 * 形式が不正な ID も 404 に畳む。
 * 422 を返すと「形式は正しいが存在しない ID」と区別でき、総当たりの手掛かりになる。
 */
export function readShopIdParam(c: Context<OwnerEnv>): ShopId {
  try {
    return toShopId(c.req.param('shopId') ?? '');
  } catch {
    throw notFound();
  }
}

/** shopId 以外の ID。所有権は必ず SQL 側で確かめるので、ここでは形式だけを見る */
export function readIdParam(c: Context<OwnerEnv>, name: string): string {
  const raw = c.req.param(name) ?? '';
  if (raw === '') {
    throw notFound();
  }
  return raw;
}

/** 本文の検証失敗だけが 422。どのフィールドが悪いかは返さない（http-error.ts の方針） */
export async function readJsonBody<TValue>(
  c: Context<OwnerEnv>,
  schema: ZodType<TValue>,
): Promise<TValue> {
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw invalidInput();
  }
  return parsed.data;
}

/**
 * リポジトリの「所有していない（= null）」を 404 に変換する唯一の場所。
 * 各ハンドラが個別に if (x === null) を書くと、書き忘れが素通りの穴になる。
 */
export function requireOwned<TValue>(value: TValue | null): TValue {
  if (value === null) {
    throw notFound();
  }
  return value;
}
```

```ts
// apps/api/src/routes/testing/owner-app.ts
import { Hono } from 'hono';

import type { Viewer } from '../../auth/actor';
import type { LocalD1 } from '../../db/testing/local-d1';
import type { AppBindings, AppEnv } from '../../lib/app-env';
import { errorHandler, notFoundHandler } from '../../middleware/error-handler';
import { ownerRoutes } from '../owner';

export type OwnerTestApp = {
  readonly request: (path: string, init?: RequestInit) => Promise<Response>;
};

/**
 * viewer を直接注入する。
 * Better Auth のセッション生成はここでの関心ではない（認証そのものは Phase 4 の
 * load-actor.test.ts が担当している）。ここで検証したいのは
 * 「viewer がこの値のとき、ルートがどう振る舞うか」だけである。
 */
export function createOwnerTestApp(local: LocalD1, viewer: Viewer): OwnerTestApp {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  app.use('*', async (c, next) => {
    c.set('viewer', viewer);
    await next();
  });
  app.route('/owner', ownerRoutes);

  const bindings: Pick<AppBindings, 'DB' | 'MEDIA'> = {
    DB: local.d1,
    MEDIA: local.mediaBucket,
  };
  return {
    request: async (path, init) => await app.request(path, init, bindings),
  };
}
```

`app.request` の第 3 引数の型は `E['Bindings'] | {}`（`node_modules/hono/dist/types/hono-base.d.ts:201` で確認）なので、`DB` と `MEDIA` だけの部分オブジェクトを `as` なしで渡せる。

- [ ] **Step 13: 店舗ルートを実装する**

```ts
// apps/api/src/routes/owner/shop-routes.ts
import { Hono } from 'hono';
import {
  shopClosureCreateSchema,
  seatSettingsInputSchema,
  shopHoursInputSchema,
} from '@meshimap/core';

import { createDatabase } from '../../db/client';
import { buildEntityId, createUuidHex } from '../../lib/entity-id';
import { invalidInput, notFound } from '../../lib/http-error';
import { parseStatsRangeDays } from '../../lib/stats-range';
import {
  addShopClosureAsOwner,
  deleteShopClosureAsOwner,
  listShopHoursAsOwner,
  replaceShopHoursAsOwner,
} from '../../repositories/owner-hours-repository';
import { findOwnedShopLocation, listOwnedShops } from '../../repositories/owner-scope';
import {
  findSeatSettingsAsOwner,
  upsertSeatSettingsAsOwner,
} from '../../repositories/owner-seat-repository';
import { loadShopStatsAsOwner } from '../../repositories/shop-stats-repository';
import { readIdParam, readJsonBody, readShopIdParam, requireOwned } from './guard';
import type { OwnerEnv } from './guard';

export const shopRoutes = new Hono<OwnerEnv>();

shopRoutes.get('/shops', async (c) => {
  const shops = await listOwnedShops(createDatabase(c.env.DB), c.get('owner'));
  return c.json({ shops });
});

shopRoutes.get('/shops/:shopId/stats', async (c) => {
  const days = parseStatsRangeDays(c.req.query('days'));
  if (days === null) {
    throw invalidInput();
  }
  const stats = await loadShopStatsAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    readShopIdParam(c),
    days,
    new Date(),
  );
  return c.json(requireOwned(stats));
});

shopRoutes.get('/shops/:shopId/location', async (c) => {
  const location = await findOwnedShopLocation(
    createDatabase(c.env.DB),
    c.get('owner'),
    readShopIdParam(c),
  );
  return c.json(requireOwned(location));
});

shopRoutes.get('/shops/:shopId/hours', async (c) => {
  const result = await listShopHoursAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    readShopIdParam(c),
  );
  return c.json(requireOwned(result));
});

shopRoutes.put('/shops/:shopId/hours', async (c) => {
  const shopId = readShopIdParam(c);
  const input = await readJsonBody(c, shopHoursInputSchema);
  const hours = await replaceShopHoursAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    shopId,
    input,
    () => buildEntityId('shopHour', createUuidHex()),
  );
  return c.json({ hours: requireOwned(hours) });
});

shopRoutes.post('/shops/:shopId/closures', async (c) => {
  const shopId = readShopIdParam(c);
  const input = await readJsonBody(c, shopClosureCreateSchema);
  const closure = await addShopClosureAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    shopId,
    buildEntityId('shopClosure', createUuidHex()),
    input,
  );
  return c.json(requireOwned(closure), 201);
});

shopRoutes.delete('/shops/:shopId/closures/:closureId', async (c) => {
  const shopId = readShopIdParam(c);
  const closureId = readIdParam(c, 'closureId');
  const isDeleted = await deleteShopClosureAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    shopId,
    closureId,
  );
  if (!isDeleted) {
    throw notFound();
  }
  return c.body(null, 204);
});

shopRoutes.get('/shops/:shopId/seats', async (c) => {
  const seats = await findSeatSettingsAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    readShopIdParam(c),
  );
  return c.json(requireOwned(seats));
});

shopRoutes.put('/shops/:shopId/seats', async (c) => {
  const shopId = readShopIdParam(c);
  const input = await readJsonBody(c, seatSettingsInputSchema);
  const seats = await upsertSeatSettingsAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    shopId,
    input,
  );
  return c.json(requireOwned(seats));
});
```

**`GET /owner/shops/:shopId/hours`（#18 の `PUT` と対になる読み取り）を足している。** 権限マトリクスの表は `PUT` しか挙げていないが、営業時間画面はまず現在値を読む必要がある。Task 8-14 で `ENDPOINT_CASES` に行を追加する際、この 1 本も必ず含める（**本計画書の権限マトリクス表には #17 として既に入れてあり、以降の通し番号も振り直し済み**）。

- [ ] **Step 14: 写真ルートを実装する**

```ts
// apps/api/src/routes/owner/photo-routes.ts
import { Hono } from 'hono';
import { photoCaptionUpdateSchema, photoOrderUpdateSchema } from '@meshimap/core';

import { createDatabase } from '../../db/client';
import { buildEntityId, createUuidHex } from '../../lib/entity-id';
import { invalidInput, notFound } from '../../lib/http-error';
import {
  deleteShopPhotoAsOwner,
  listShopPhotosAsOwner,
  reorderShopPhotosAsOwner,
  updateShopPhotoAsOwner,
  uploadShopPhotoAsOwner,
} from '../../repositories/owner-photo-repository';
import { readIdParam, readJsonBody, readShopIdParam, requireOwned } from './guard';
import type { OwnerEnv } from './guard';

export const photoRoutes = new Hono<OwnerEnv>();

/** multipart のフィールド名。モバイル側（features/owner/api.ts）と一致させる */
const UPLOAD_FIELD_NAME = 'file';

photoRoutes.get('/shops/:shopId/photos', async (c) => {
  const photos = await listShopPhotosAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    readShopIdParam(c),
  );
  return c.json({ photos: requireOwned(photos) });
});

photoRoutes.post('/shops/:shopId/photos', async (c) => {
  const shopId = readShopIdParam(c);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get(UPLOAD_FIELD_NAME);
  // クライアントが申告する type は見ない。実際のバイト列だけを信用する（Task 8-2）
  if (!(file instanceof File)) {
    throw invalidInput();
  }
  const uuidHex = createUuidHex();
  const result = await uploadShopPhotoAsOwner(
    createDatabase(c.env.DB),
    c.env.MEDIA,
    c.get('owner'),
    shopId,
    buildEntityId('shopPhoto', uuidHex),
    uuidHex,
    await file.arrayBuffer(),
  );
  const decided = requireOwned(result);
  if (!decided.ok) {
    // 大きすぎる・対応しない形式はどちらも入力の問題。理由は本文に出さない
    throw invalidInput();
  }
  return c.json(decided.photo, 201);
});

photoRoutes.patch('/shops/:shopId/photos/:photoId', async (c) => {
  const shopId = readShopIdParam(c);
  const photoId = readIdParam(c, 'photoId');
  const input = await readJsonBody(c, photoCaptionUpdateSchema);
  const photo = await updateShopPhotoAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    shopId,
    photoId,
    input,
  );
  return c.json(requireOwned(photo));
});

photoRoutes.put('/shops/:shopId/photo-order', async (c) => {
  const shopId = readShopIdParam(c);
  const input = await readJsonBody(c, photoOrderUpdateSchema);
  const photos = await reorderShopPhotosAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    shopId,
    input.photoIds,
  );
  return c.json({ photos: requireOwned(photos) });
});

photoRoutes.delete('/shops/:shopId/photos/:photoId', async (c) => {
  const shopId = readShopIdParam(c);
  const photoId = readIdParam(c, 'photoId');
  const isDeleted = await deleteShopPhotoAsOwner(
    createDatabase(c.env.DB),
    c.env.MEDIA,
    c.get('owner'),
    shopId,
    photoId,
  );
  if (!isDeleted) {
    throw notFound();
  }
  return c.body(null, 204);
});
```

- [ ] **Step 15: サブアプリを組み立てる**

```ts
// apps/api/src/routes/owner/index.ts
import { Hono } from 'hono';

import { requireOwner } from './guard';
import type { OwnerEnv } from './guard';
import { photoRoutes } from './photo-routes';
import { shopRoutes } from './shop-routes';

/**
 * /owner 配下のサブアプリ。
 * requireOwner をここで 1 回だけ掛ける。各ルートファイルには権限判定を書かない
 * （書けるようにすると、書き忘れが穴になる）。
 */
export const ownerRoutes = new Hono<OwnerEnv>();

ownerRoutes.use('*', requireOwner);
ownerRoutes.route('/', shopRoutes);
ownerRoutes.route('/', photoRoutes);
```

- [ ] **Step 16: ガードのテストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/api -- src/routes/owner/guard.test.ts`
Expected: PASS（8 件）。

- [ ] **Step 17: 店舗ルートのテストを書いて実行する（失敗 → 通過）**

```ts
// apps/api/src/routes/owner/shop-routes.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toActor } from '../../auth/actor';
import { createMigratedD1 } from '../../db/testing/local-d1';
import type { LocalD1 } from '../../db/testing/local-d1';
import { seedTwoOwners } from '../../repositories/testing/owner-fixtures';
import { createOwnerTestApp } from '../testing/owner-app';
import type { OwnerTestApp } from '../testing/owner-app';

let local: LocalD1;
let aliceApp: OwnerTestApp;
let bobApp: OwnerTestApp;

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const validHours = {
  hours: [{ dayOfWeek: 1, opensAt: '11:00', closesAt: '22:00', lastOrderAt: null }],
};

beforeEach(async () => {
  local = await createMigratedD1();
  await seedTwoOwners(local);
  aliceApp = createOwnerTestApp(local, toActor('usr_alice', 'owner'));
  bobApp = createOwnerTestApp(local, toActor('usr_bob', 'owner'));
});

afterEach(async () => {
  await local.dispose();
});

describe('GET /owner/shops', () => {
  it('自分の店だけが返る', async () => {
    const response = await aliceApp.request('/owner/shops');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      shops: [expect.objectContaining({ id: 'shp_alice' })],
    });
  });
});

describe('GET /owner/shops/:shopId/stats', () => {
  it('既定は 7 日ぶんの点が返る', async () => {
    const response = await aliceApp.request('/owner/shops/shp_alice/stats');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ days: 7 });
  });

  it('days=90 を指定できる', async () => {
    const response = await aliceApp.request('/owner/shops/shp_alice/stats?days=90');
    expect(await response.json()).toMatchObject({ days: 90 });
  });

  it('許可されていない days は 422 を返す', async () => {
    expect((await aliceApp.request('/owner/shops/shp_alice/stats?days=365')).status).toBe(422);
  });

  it('他人の店は 404 を返す', async () => {
    expect((await bobApp.request('/owner/shops/shp_alice/stats')).status).toBe(404);
  });
});

describe('営業時間', () => {
  it('GET は現在の営業時間と臨時休業を返す', async () => {
    const response = await aliceApp.request('/owner/shops/shp_alice/hours');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      hours: expect.any(Array),
      closures: expect.any(Array),
    });
  });

  it('PUT は 200 を返し、保存内容が GET で読み戻せる', async () => {
    const put = await aliceApp.request('/owner/shops/shp_alice/hours', jsonInit('PUT', validHours));
    expect(put.status).toBe(200);
    const get = await aliceApp.request('/owner/shops/shp_alice/hours');
    const body = await get.json();
    expect(body).toMatchObject({
      hours: [expect.objectContaining({ dayOfWeek: 1, opensAt: '11:00' })],
    });
  });

  it('本文が不正なら 422 を返す', async () => {
    const response = await aliceApp.request(
      '/owner/shops/shp_alice/hours',
      jsonInit('PUT', {
        hours: [{ dayOfWeek: 9, opensAt: '11:00', closesAt: '22:00', lastOrderAt: null }],
      }),
    );
    expect(response.status).toBe(422);
  });

  it('本文が JSON ですらないときも 422 を返す（500 にしない）', async () => {
    const response = await aliceApp.request('/owner/shops/shp_alice/hours', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: 'これはJSONではない',
    });
    expect(response.status).toBe(422);
  });

  it('他人の店への PUT は 404 を返し、相手の営業時間は変わらない', async () => {
    const before = await local.d1
      .prepare(`SELECT count(*) AS count FROM shop_hours WHERE shop_id = 'shp_alice'`)
      .first<{ count: number }>();
    const response = await bobApp.request(
      '/owner/shops/shp_alice/hours',
      jsonInit('PUT', validHours),
    );
    expect(response.status).toBe(404);
    const after = await local.d1
      .prepare(`SELECT count(*) AS count FROM shop_hours WHERE shop_id = 'shp_alice'`)
      .first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });
});

describe('臨時休業', () => {
  it('POST は 201 を返す', async () => {
    const response = await aliceApp.request(
      '/owner/shops/shp_alice/closures',
      jsonInit('POST', { closedOn: '2026-12-31', reason: '年末休業' }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ closedOn: '2026-12-31', reason: '年末休業' });
  });

  it('生成される ID は shc_ で始まる', async () => {
    const response = await aliceApp.request(
      '/owner/shops/shp_alice/closures',
      jsonInit('POST', { closedOn: '2026-12-30', reason: null }),
    );
    const body: { id: string } = await response.json();
    expect(body.id).toMatch(/^shc_[0-9a-f]{32}$/);
  });

  it('DELETE は 204 を返し、本文が空である', async () => {
    const created = await aliceApp.request(
      '/owner/shops/shp_alice/closures',
      jsonInit('POST', { closedOn: '2026-12-29', reason: null }),
    );
    const { id }: { id: string } = await created.json();
    const response = await aliceApp.request(`/owner/shops/shp_alice/closures/${id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('存在しない臨時休業の DELETE は 404 を返す', async () => {
    const response = await aliceApp.request('/owner/shops/shp_alice/closures/shc_nope', {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
  });
});

describe('座席設定', () => {
  it('未設定の店でも既定値が 200 で返る', async () => {
    const response = await aliceApp.request('/owner/shops/shp_alice/seats');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      capacity: 10,
      slotMinutes: 90,
      maxParallel: 1,
      acceptsReservation: false,
    });
  });

  it('PUT で保存した内容が GET で読み戻せる', async () => {
    await aliceApp.request(
      '/owner/shops/shp_alice/seats',
      jsonInit('PUT', { capacity: 24, slotMinutes: 120, maxParallel: 2, acceptsReservation: true }),
    );
    expect(await (await aliceApp.request('/owner/shops/shp_alice/seats')).json()).toMatchObject({
      capacity: 24,
      acceptsReservation: true,
    });
  });

  it('他人の店の座席設定は 404 を返す', async () => {
    expect((await bobApp.request('/owner/shops/shp_alice/seats')).status).toBe(404);
  });
});
```

Run: `npm run test -w @meshimap/api -- src/routes/owner/shop-routes.test.ts`
Expected: 実装前に書いた場合は FAIL、Step 13 の実装が入っていれば PASS（17 件）。**必ず一度、`shopRoutes.get('/shops', ...)` をコメントアウトして 404 になることを見てから戻すこと**（ルートが本当に配線されているかは、落ちるところを見ないと分からない）。

- [ ] **Step 18: 写真ルートのテストを書いて実行する**

```ts
// apps/api/src/routes/owner/photo-routes.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UPLOAD_MAX_BYTES } from '@meshimap/core';

import { toActor } from '../../auth/actor';
import { createMigratedD1 } from '../../db/testing/local-d1';
import type { LocalD1 } from '../../db/testing/local-d1';
import { seedTwoOwners } from '../../repositories/testing/owner-fixtures';
import { createOwnerTestApp } from '../testing/owner-app';
import type { OwnerTestApp } from '../testing/owner-app';

let local: LocalD1;
let aliceApp: OwnerTestApp;
let bobApp: OwnerTestApp;

/** 先頭 8 バイトが PNG シグネチャのダミー画像 */
function pngFile(totalLength = 64): File {
  const bytes = new Uint8Array(totalLength);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return new File([bytes], 'photo.png', { type: 'image/png' });
}

function uploadInit(file: File): RequestInit {
  const form = new FormData();
  form.append('file', file);
  return { method: 'POST', body: form };
}

async function uploadPhoto(app: OwnerTestApp, shopId: string, file = pngFile()): Promise<Response> {
  return await app.request(`/owner/shops/${shopId}/photos`, uploadInit(file));
}

beforeEach(async () => {
  local = await createMigratedD1();
  await seedTwoOwners(local);
  aliceApp = createOwnerTestApp(local, toActor('usr_alice', 'owner'));
  bobApp = createOwnerTestApp(local, toActor('usr_bob', 'owner'));
});

afterEach(async () => {
  await local.dispose();
});

describe('POST /owner/shops/:shopId/photos', () => {
  it('201 を返し、R2 にオブジェクトが置かれる', async () => {
    const response = await uploadPhoto(aliceApp, 'shp_alice');
    expect(response.status).toBe(201);
    const body: { id: string; r2Key: string } = await response.json();
    expect(body.id).toMatch(/^pht_[0-9a-f]{32}$/);
    expect(body.r2Key).toBe(`shop-photos/shp_alice/${body.id.slice('pht_'.length)}.png`);
    expect(await local.mediaBucket.get(body.r2Key)).not.toBeNull();
  });

  it('拡張子は申告された名前ではなく中身から決まる（photo.png と名乗る JPEG は .jpg になる）', async () => {
    const jpegBytes = new Uint8Array(32);
    jpegBytes.set([0xff, 0xd8, 0xff], 0);
    const disguised = new File([jpegBytes], 'photo.png', { type: 'image/png' });
    const response = await uploadPhoto(aliceApp, 'shp_alice', disguised);
    const body: { r2Key: string } = await response.json();
    expect(body.r2Key.endsWith('.jpg')).toBe(true);
  });

  it('画像でないバイト列は 422 を返し、R2 に何も置かれない', async () => {
    const notImage = new File([new Uint8Array([0x4d, 0x5a, 0x90, 0x00])], 'evil.png', {
      type: 'image/png',
    });
    const response = await uploadPhoto(aliceApp, 'shp_alice', notImage);
    expect(response.status).toBe(422);
    const listed = await local.mediaBucket.list();
    expect(listed.objects).toHaveLength(0);
  });

  it('上限を 1 バイト超えたら 422 を返す', async () => {
    const response = await uploadPhoto(aliceApp, 'shp_alice', pngFile(UPLOAD_MAX_BYTES + 1));
    expect(response.status).toBe(422);
  });

  it('file フィールドが無ければ 422 を返す', async () => {
    const response = await aliceApp.request('/owner/shops/shp_alice/photos', {
      method: 'POST',
      body: new FormData(),
    });
    expect(response.status).toBe(422);
  });

  it('他人の店への投稿は 404 を返し、R2 に何も置かれない', async () => {
    const response = await uploadPhoto(bobApp, 'shp_alice');
    expect(response.status).toBe(404);
    const listed = await local.mediaBucket.list();
    expect(listed.objects).toHaveLength(0);
  });
});

describe('GET / PATCH / PUT / DELETE の写真ルート', () => {
  it('GET は自店の写真一覧を返す', async () => {
    await uploadPhoto(aliceApp, 'shp_alice');
    const response = await aliceApp.request('/owner/shops/shp_alice/photos');
    expect(response.status).toBe(200);
    const body: { photos: readonly unknown[] } = await response.json();
    expect(body.photos).toHaveLength(1);
  });

  it('PATCH でキャプションとカバー指定を変えられる', async () => {
    const { id }: { id: string } = await (await uploadPhoto(aliceApp, 'shp_alice')).json();
    const response = await aliceApp.request(`/owner/shops/shp_alice/photos/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ caption: '外観', isCover: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ caption: '外観', isCover: true });
  });

  it('PUT /photo-order で並び順を入れ替えられる', async () => {
    const first: { id: string } = await (await uploadPhoto(aliceApp, 'shp_alice')).json();
    const second: { id: string } = await (await uploadPhoto(aliceApp, 'shp_alice')).json();
    const response = await aliceApp.request('/owner/shops/shp_alice/photo-order', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ photoIds: [second.id, first.id] }),
    });
    expect(response.status).toBe(200);
    const body: { photos: readonly { id: string }[] } = await response.json();
    expect(body.photos.map((photo) => photo.id)).toEqual([second.id, first.id]);
  });

  it('DELETE は 204 を返し、R2 のオブジェクトも消える', async () => {
    const created: { id: string; r2Key: string } = await (
      await uploadPhoto(aliceApp, 'shp_alice')
    ).json();
    const response = await aliceApp.request(`/owner/shops/shp_alice/photos/${created.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(204);
    expect(await local.mediaBucket.get(created.r2Key)).toBeNull();
  });

  it('他人の写真は DELETE できず 404 になり、R2 のオブジェクトも残る', async () => {
    const created: { id: string; r2Key: string } = await (
      await uploadPhoto(aliceApp, 'shp_alice')
    ).json();
    const response = await bobApp.request(`/owner/shops/shp_alice/photos/${created.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
    expect(await local.mediaBucket.get(created.r2Key)).not.toBeNull();
  });
});
```

Run: `npm run test -w @meshimap/api -- src/routes/owner/photo-routes.test.ts`
Expected: PASS（12 件）。

- [ ] **Step 19: わざと壊して検証が効いていることを確認する**

`ownerRoutes.use('*', requireOwner)` の行を一時的にコメントアウトする。

Run: `npm run test -w @meshimap/api -- src/routes/owner`
Expected: FAIL。`guard.test.ts` の「未認証は 401 を返す」「一般利用者は 403 を返す」「システム管理者も 403 を返す」が落ちる。さらに `c.get('owner')` が `undefined` になるため、リポジトリ呼び出しが例外になり 500 を返すテストも道連れで落ちる。**ガードを外すと全体が壊れる**という状態が望ましい（外しても一部しか落ちないなら、ガードに依存していないハンドラがあるということ）。

次に `guard.ts` の `readShopIdParam` の `catch` を `throw invalidInput()` に変える。
Expected: FAIL。「形式が不正な店舗 ID は 422 ではなく 404 になる」が `expected 422 to be 404` で落ちる。

次に `photo-routes.ts` の `if (!decided.ok) { throw invalidInput(); }` を削除して `return c.json(decided, 201)` にする。
Expected: FAIL。「画像でないバイト列は 422 を返し、R2 に何も置かれない」「上限を 1 バイト超えたら 422 を返す」が `expected 201 to be 422` で落ちる。

**3 つとも確認したら元に戻し、再度テストが緑になることを確認する。**

- [ ] **Step 20: 型・lint・全テストを通す**

Run: `npm run typecheck -w @meshimap/api && npm run lint && npm run test -w @meshimap/api`
Expected: すべて成功。`verbatimModuleSyntax` のため型だけの import は `import type` にする。`noUnusedLocals` が効くので、実装中に消し忘れた import があればここで落ちる。

- [ ] **Step 21: ミューテーションテストを実行する**

Run: `npm run test:mutation -w @meshimap/api`
Expected: スコア 85 以上。`requireOwned` の `value === null` → `value !== null` は多数のテストが殺す。`parseStatsRangeDays` の `String(days) === raw` → `!==` は「許可された値はそのまま数値で返す」が殺す。生き残った変異があれば殺せるテストを足す。**除外は選択肢にない。**

- [ ] **Step 22: コミット**

```bash
git add apps/api/src/routes/owner apps/api/src/routes/testing
git commit -m "feat(api): /owner サブアプリと店舗・営業時間・座席・写真ルートを追加"
```

---

## Task 8-14: メニュー・レビュー・クーポン・申請ルート、閲覧記録、権限マトリクス拡張

**Files:**

- Create: `apps/api/src/routes/owner/menu-routes.ts`
- Create: `apps/api/src/routes/owner/review-routes.ts`
- Create: `apps/api/src/routes/owner/campaign-routes.ts`
- Create: `apps/api/src/routes/owner/application-routes.ts`
- Create: `apps/api/src/routes/owner/menu-routes.test.ts`
- Create: `apps/api/src/routes/owner/review-routes.test.ts`
- Create: `apps/api/src/routes/owner/campaign-routes.test.ts`
- Create: `apps/api/src/routes/owner/application-routes.test.ts`
- Modify: `apps/api/src/routes/owner/index.ts`（4 本を追加でマウント）
- Modify: `apps/api/src/routes/shops.ts`（`POST /shops/:shopId/views` を追加。Phase 6 が作るファイル）
- Modify: `apps/api/src/routes/shops.test.ts`（同上のテスト）
- Modify: `apps/api/src/index.ts`（`/owner` をマウント。Phase 4 が作るファイル）
- Modify: `apps/api/src/routes/permission-matrix.test.ts`（Phase 4 Task 4-12 の `ENDPOINT_CASES`）
- Modify: `apps/api/src/routes/permission-matrix.test.ts`（Phase 4 Task 4-12 / 4-14 の `EXPECTED_ROUTE_PATTERNS`）
- 触らない: 同じファイルの `DELEGATED_ROUTE_PATTERNS` / `DELEGATABLE_PATH_PATTERN`（Phase 7 が導入。**Phase 8 は委譲しない**。理由は「権限マトリクス」節の「Phase 8 は委譲しない」を参照）

**Interfaces:**

- Consumes: `OwnerEnv` / `requireOwner` / `readShopIdParam` / `readIdParam` / `readJsonBody` / `requireOwned`（8-13）、`buildEntityId` / `createUuidHex`（8-13）、`createOwnerTestApp`（8-13）、Task 8-7 / 8-9 / 8-10 / 8-12 の各リポジトリ関数、`recordShopView`（8-11）、`toReviewId`（core）
- Produces:
  - `const menuRoutes: Hono<OwnerEnv>` / `const reviewRoutes: Hono<OwnerEnv>` / `const campaignRoutes: Hono<OwnerEnv>` / `const applicationRoutes: Hono<OwnerEnv>`
  - `ownerRoutes` に上記 4 本が加わる（Phase 8 の `/owner` 配下がこれで完成する）
  - `POST /shops/:shopId/views`（公開・常に 204）
  - `ENDPOINT_CASES` に Phase 8 の 32 行（権限マトリクス #14〜#45）が加わり、`EXPECTED_ROUTE_PATTERNS` が 19 本 → **51 本**になる（`DELEGATED_ROUTE_PATTERNS` は予約系 9 本のまま）

### `/owner/reviews/:reviewId/...` が `shopId` を取らない理由

レビュー返信の入り口は「レビュー一覧の 1 件」であり、クライアントは `reviewId` しか持っていない。`shopId` も URL に含めると、クライアントが両方を正しく組み立てる責任を負い、食い違ったときの挙動（`shopId` は自店だが `reviewId` は他店）を決めなければならない。`findOwnedReviewShopId(db, actor, reviewId)` が `reviews → shops.owner_id` を 1 本の SQL で辿るので、`reviewId` だけで所有権が確定する。**URL に余分な ID を置かないほうが、食い違いという状態自体が存在しなくなる。** クーポンの `PATCH` / `DELETE` も同じ理由で `campaignId` だけを取る。

### 閲覧記録（#45）を公開にする理由と、常に 204 を返す理由

閲覧数は匿名を含めて数える。認証を要求すると「ログインしている人の閲覧しか数えない」という別物の指標になってしまう。

応答は**常に 204**。存在しない `shopId` でも 204 を返すのは、404 を返すと「この ID の店は存在しない」が誰にでも分かる列挙経路になるからである。`recordShopView` は外部キー違反を握って何もしない（Task 8-11 で実装済み）ので、行は増えない。

- [ ] **Step 1: メニュールートの失敗するテストを書く**

```ts
// apps/api/src/routes/owner/menu-routes.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toActor } from '../../auth/actor';
import { createMigratedD1 } from '../../db/testing/local-d1';
import type { LocalD1 } from '../../db/testing/local-d1';
import { seedTwoOwners } from '../../repositories/testing/owner-fixtures';
import { createOwnerTestApp } from '../testing/owner-app';
import type { OwnerTestApp } from '../testing/owner-app';

let local: LocalD1;
let aliceApp: OwnerTestApp;
let bobApp: OwnerTestApp;

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function createCategory(app: OwnerTestApp, name = 'ランチ'): Promise<{ id: string }> {
  const response = await app.request(
    '/owner/shops/shp_alice/menu/categories',
    jsonInit('POST', { name }),
  );
  return await response.json();
}

async function createItem(app: OwnerTestApp, categoryId: string): Promise<{ id: string }> {
  const response = await app.request(
    '/owner/shops/shp_alice/menu/items',
    jsonInit('POST', {
      categoryId,
      name: '醤油ラーメン',
      description: '鶏ガラベース',
      priceYen: 900,
      isRecommended: true,
    }),
  );
  return await response.json();
}

beforeEach(async () => {
  local = await createMigratedD1();
  await seedTwoOwners(local);
  aliceApp = createOwnerTestApp(local, toActor('usr_alice', 'owner'));
  bobApp = createOwnerTestApp(local, toActor('usr_bob', 'owner'));
});

afterEach(async () => {
  await local.dispose();
});

describe('GET /owner/shops/:shopId/menu', () => {
  it('カテゴリと項目が入れ子で返る', async () => {
    const category = await createCategory(aliceApp);
    await createItem(aliceApp, category.id);
    const response = await aliceApp.request('/owner/shops/shp_alice/menu');
    expect(response.status).toBe(200);
    const body: { categories: readonly { id: string; items: readonly { name: string }[] }[] } =
      await response.json();
    expect(body.categories).toHaveLength(1);
    expect(body.categories[0]?.items[0]?.name).toBe('醤油ラーメン');
  });

  it('メニューが 1 件も無い店では categories が空配列で返る（null ではない）', async () => {
    const response = await aliceApp.request('/owner/shops/shp_alice/menu');
    expect(await response.json()).toEqual({ categories: [] });
  });

  it('他人の店は 404 を返す', async () => {
    expect((await bobApp.request('/owner/shops/shp_alice/menu')).status).toBe(404);
  });
});

describe('カテゴリ', () => {
  it('POST は 201 を返し、ID は mnc_ で始まる', async () => {
    const response = await aliceApp.request(
      '/owner/shops/shp_alice/menu/categories',
      jsonInit('POST', { name: 'ディナー' }),
    );
    expect(response.status).toBe(201);
    const body: { id: string; name: string } = await response.json();
    expect(body.id).toMatch(/^mnc_[0-9a-f]{32}$/);
    expect(body.name).toBe('ディナー');
  });

  it('名前が空文字なら 422 を返す', async () => {
    const response = await aliceApp.request(
      '/owner/shops/shp_alice/menu/categories',
      jsonInit('POST', { name: '' }),
    );
    expect(response.status).toBe(422);
  });

  it('DELETE は 204 を返し、配下の項目も消える', async () => {
    const category = await createCategory(aliceApp);
    const item = await createItem(aliceApp, category.id);
    const response = await aliceApp.request(
      `/owner/shops/shp_alice/menu/categories/${category.id}`,
      {
        method: 'DELETE',
      },
    );
    expect(response.status).toBe(204);
    const remaining = await local.d1
      .prepare(`SELECT count(*) AS count FROM menu_items WHERE id = ?`)
      .bind(item.id)
      .first<{ count: number }>();
    expect(remaining?.count).toBe(0);
  });

  it('他人の店のカテゴリは DELETE できず 404 になり、行も残る', async () => {
    const category = await createCategory(aliceApp);
    const response = await bobApp.request(`/owner/shops/shp_alice/menu/categories/${category.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
    const remaining = await local.d1
      .prepare(`SELECT count(*) AS count FROM menu_categories WHERE id = ?`)
      .bind(category.id)
      .first<{ count: number }>();
    expect(remaining?.count).toBe(1);
  });
});

describe('メニュー項目', () => {
  it('POST は 201 を返し、ID は mni_ で始まる', async () => {
    const category = await createCategory(aliceApp);
    const item = await createItem(aliceApp, category.id);
    expect(item.id).toMatch(/^mni_[0-9a-f]{32}$/);
  });

  it('PATCH で価格を変えられる', async () => {
    const category = await createCategory(aliceApp);
    const item = await createItem(aliceApp, category.id);
    const response = await aliceApp.request(
      `/owner/shops/shp_alice/menu/items/${item.id}`,
      jsonInit('PATCH', {
        categoryId: category.id,
        name: '醤油ラーメン',
        description: '鶏ガラベース',
        priceYen: 1000,
        isRecommended: false,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ priceYen: 1000, isRecommended: false });
  });

  it('価格が負なら 422 を返す', async () => {
    const category = await createCategory(aliceApp);
    const response = await aliceApp.request(
      '/owner/shops/shp_alice/menu/items',
      jsonInit('POST', {
        categoryId: category.id,
        name: 'ただ飯',
        description: null,
        priceYen: -1,
        isRecommended: false,
      }),
    );
    expect(response.status).toBe(422);
  });

  it('DELETE は 204 を返す', async () => {
    const category = await createCategory(aliceApp);
    const item = await createItem(aliceApp, category.id);
    const response = await aliceApp.request(`/owner/shops/shp_alice/menu/items/${item.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(204);
  });

  it('他人の店の項目は PATCH できず 404 になり、値も変わらない', async () => {
    const category = await createCategory(aliceApp);
    const item = await createItem(aliceApp, category.id);
    const response = await bobApp.request(
      `/owner/shops/shp_alice/menu/items/${item.id}`,
      jsonInit('PATCH', {
        categoryId: category.id,
        name: '乗っ取り',
        description: null,
        priceYen: 1,
        isRecommended: false,
      }),
    );
    expect(response.status).toBe(404);
    const row = await local.d1
      .prepare(`SELECT name, price_yen FROM menu_items WHERE id = ?`)
      .bind(item.id)
      .first<{ name: string; price_yen: number }>();
    expect(row).toEqual({ name: '醤油ラーメン', price_yen: 900 });
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/api -- src/routes/owner/menu-routes.test.ts`
Expected: FAIL。`ownerRoutes` にメニュールートが無いので、全 12 件が `expected 404 to be 200`（および 201 / 204）で落ちる。**「import が解決できない」ではなく「404 が返る」で落ちることを目で確認する。** これはルートの配線漏れを検出できるテストであることの確認になる。

- [ ] **Step 3: メニュールートを実装する**

```ts
// apps/api/src/routes/owner/menu-routes.ts
import { Hono } from 'hono';
import { menuCategoryCreateSchema, menuItemInputSchema } from '@meshimap/core';

import { createDatabase } from '../../db/client';
import { buildEntityId, createUuidHex } from '../../lib/entity-id';
import { notFound } from '../../lib/http-error';
import {
  createMenuCategoryAsOwner,
  createMenuItemAsOwner,
  deleteMenuCategoryAsOwner,
  deleteMenuItemAsOwner,
  listMenuAsOwner,
  updateMenuItemAsOwner,
} from '../../repositories/owner-menu-repository';
import { readIdParam, readJsonBody, readShopIdParam, requireOwned } from './guard';
import type { OwnerEnv } from './guard';

export const menuRoutes = new Hono<OwnerEnv>();

menuRoutes.get('/shops/:shopId/menu', async (c) => {
  const categories = await listMenuAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    readShopIdParam(c),
  );
  return c.json({ categories: requireOwned(categories) });
});

menuRoutes.post('/shops/:shopId/menu/categories', async (c) => {
  const shopId = readShopIdParam(c);
  const input = await readJsonBody(c, menuCategoryCreateSchema);
  const category = await createMenuCategoryAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    shopId,
    buildEntityId('menuCategory', createUuidHex()),
    input,
  );
  return c.json(requireOwned(category), 201);
});

menuRoutes.delete('/shops/:shopId/menu/categories/:categoryId', async (c) => {
  const shopId = readShopIdParam(c);
  const categoryId = readIdParam(c, 'categoryId');
  const isDeleted = await deleteMenuCategoryAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    shopId,
    categoryId,
  );
  if (!isDeleted) {
    throw notFound();
  }
  return c.body(null, 204);
});

menuRoutes.post('/shops/:shopId/menu/items', async (c) => {
  const shopId = readShopIdParam(c);
  const input = await readJsonBody(c, menuItemInputSchema);
  const item = await createMenuItemAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    shopId,
    buildEntityId('menuItem', createUuidHex()),
    input,
  );
  return c.json(requireOwned(item), 201);
});

menuRoutes.patch('/shops/:shopId/menu/items/:menuItemId', async (c) => {
  const shopId = readShopIdParam(c);
  const menuItemId = readIdParam(c, 'menuItemId');
  const input = await readJsonBody(c, menuItemInputSchema);
  const item = await updateMenuItemAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    shopId,
    menuItemId,
    input,
  );
  return c.json(requireOwned(item));
});

menuRoutes.delete('/shops/:shopId/menu/items/:menuItemId', async (c) => {
  const shopId = readShopIdParam(c);
  const menuItemId = readIdParam(c, 'menuItemId');
  const isDeleted = await deleteMenuItemAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    shopId,
    menuItemId,
  );
  if (!isDeleted) {
    throw notFound();
  }
  return c.body(null, 204);
});
```

`apps/api/src/routes/owner/index.ts` に 2 行足す。

```ts
import { menuRoutes } from './menu-routes';
// ...
ownerRoutes.route('/', menuRoutes);
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/api -- src/routes/owner/menu-routes.test.ts`
Expected: PASS（12 件）。

- [ ] **Step 5: レビュー・返信・通報ルートのテストを書く**

```ts
// apps/api/src/routes/owner/review-routes.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toActor } from '../../auth/actor';
import { createMigratedD1 } from '../../db/testing/local-d1';
import type { LocalD1 } from '../../db/testing/local-d1';
import { seedTwoOwners } from '../../repositories/testing/owner-fixtures';
import { createOwnerTestApp } from '../testing/owner-app';
import type { OwnerTestApp } from '../testing/owner-app';

let local: LocalD1;
let aliceApp: OwnerTestApp;
let bobApp: OwnerTestApp;

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** 客が alice の店にレビューを 1 件書いた状態を作る */
async function insertReview(reviewId: string, shopId: string, rating: number): Promise<void> {
  await local.d1
    .prepare(
      `INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES ('usr_guest', 'ゲスト', 'guest@example.com', 1, 0, 0)`,
    )
    .run();
  await local.d1
    .prepare(
      // reviews に updated_at 列は無い（apps/api/src/db/schema/review.ts:65 は created_at のみ）
      `INSERT INTO reviews (id, shop_id, user_id, rating, body, status, created_at)
       VALUES (?, ?, 'usr_guest', ?, '普通でした', 'published', 1000)`,
    )
    .bind(reviewId, shopId, rating)
    .run();
}

beforeEach(async () => {
  local = await createMigratedD1();
  await seedTwoOwners(local);
  aliceApp = createOwnerTestApp(local, toActor('usr_alice', 'owner'));
  bobApp = createOwnerTestApp(local, toActor('usr_bob', 'owner'));
  await insertReview('rvw_1', 'shp_alice', 3);
});

afterEach(async () => {
  await local.dispose();
});

describe('GET /owner/shops/:shopId/reviews', () => {
  it('自店のレビューが返信状態つきで返る', async () => {
    const response = await aliceApp.request('/owner/shops/shp_alice/reviews');
    expect(response.status).toBe(200);
    const body: { reviews: readonly { review: { id: string }; reply: unknown }[] } =
      await response.json();
    expect(body.reviews[0]?.review.id).toBe('rvw_1');
    expect(body.reviews[0]?.reply).toBeNull();
  });

  it('他人の店のレビュー一覧は 404 を返す', async () => {
    expect((await bobApp.request('/owner/shops/shp_alice/reviews')).status).toBe(404);
  });
});

describe('PUT /owner/reviews/:reviewId/reply', () => {
  it('返信を作成でき 200 を返す', async () => {
    const response = await aliceApp.request(
      '/owner/reviews/rvw_1/reply',
      jsonInit('PUT', { body: 'ご来店ありがとうございました' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      reviewId: 'rvw_1',
      body: 'ご来店ありがとうございました',
    });
  });

  it('同じレビューに 2 回 PUT すると上書きになり、返信は 1 件のまま', async () => {
    await aliceApp.request('/owner/reviews/rvw_1/reply', jsonInit('PUT', { body: '一回目' }));
    await aliceApp.request('/owner/reviews/rvw_1/reply', jsonInit('PUT', { body: '二回目' }));
    const rows = await local.d1
      .prepare(`SELECT body FROM review_replies WHERE review_id = 'rvw_1'`)
      .all<{ body: string }>();
    expect(rows.results).toEqual([{ body: '二回目' }]);
  });

  it('本文が空なら 422 を返す', async () => {
    expect(
      (await aliceApp.request('/owner/reviews/rvw_1/reply', jsonInit('PUT', { body: '' }))).status,
    ).toBe(422);
  });

  it('他店のレビューには返信できず 404 を返す', async () => {
    const response = await bobApp.request(
      '/owner/reviews/rvw_1/reply',
      jsonInit('PUT', { body: '横取り' }),
    );
    expect(response.status).toBe(404);
    const count = await local.d1
      .prepare(`SELECT count(*) AS count FROM review_replies`)
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it('存在しないレビュー ID も 404 を返し、他店のレビューと応答が同じ', async () => {
    const missing = await bobApp.request(
      '/owner/reviews/rvw_nope/reply',
      jsonInit('PUT', { body: 'x' }),
    );
    const others = await bobApp.request(
      '/owner/reviews/rvw_1/reply',
      jsonInit('PUT', { body: 'x' }),
    );
    expect(await missing.text()).toBe(await others.text());
  });
});

describe('DELETE /owner/reviews/:reviewId/reply', () => {
  it('返信を消せて 204 を返す', async () => {
    await aliceApp.request('/owner/reviews/rvw_1/reply', jsonInit('PUT', { body: '消される返信' }));
    const response = await aliceApp.request('/owner/reviews/rvw_1/reply', { method: 'DELETE' });
    expect(response.status).toBe(204);
  });

  it('返信が無いときの DELETE は 404 を返す', async () => {
    expect(
      (await aliceApp.request('/owner/reviews/rvw_1/reply', { method: 'DELETE' })).status,
    ).toBe(404);
  });

  it('返信を消してもレビュー本体は残る（オーナーがレビューを消す経路を作らない）', async () => {
    await aliceApp.request('/owner/reviews/rvw_1/reply', jsonInit('PUT', { body: '返信' }));
    await aliceApp.request('/owner/reviews/rvw_1/reply', { method: 'DELETE' });
    const row = await local.d1
      .prepare(`SELECT status FROM reviews WHERE id = 'rvw_1'`)
      .first<{ status: string }>();
    expect(row?.status).toBe('published');
  });
});

describe('POST /owner/reviews/:reviewId/report', () => {
  it('通報を作成でき 201 を返す', async () => {
    const response = await aliceApp.request(
      '/owner/reviews/rvw_1/report',
      jsonInit('POST', { reason: '事実無根', detail: '来店記録がありません' }),
    );
    expect(response.status).toBe(201);
  });

  it('通報してもレビューは一切変わらない（消す・隠すができない）', async () => {
    const before = await local.d1.prepare(`SELECT * FROM reviews WHERE id = 'rvw_1'`).first();
    await aliceApp.request(
      '/owner/reviews/rvw_1/report',
      jsonInit('POST', { reason: '事実無根', detail: null }),
    );
    const after = await local.d1.prepare(`SELECT * FROM reviews WHERE id = 'rvw_1'`).first();
    expect(after).toEqual(before);
  });

  it('他店のレビューは通報できず 404 を返し、reports に行が増えない', async () => {
    const response = await bobApp.request(
      '/owner/reviews/rvw_1/report',
      jsonInit('POST', { reason: '嫌がらせ', detail: null }),
    );
    expect(response.status).toBe(404);
    const count = await local.d1
      .prepare(`SELECT count(*) AS count FROM reports`)
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });
});
```

- [ ] **Step 6: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/api -- src/routes/owner/review-routes.test.ts`
Expected: FAIL。ルート未配線のため全 12 件が 404 で落ちる。

- [ ] **Step 7: レビュールートを実装する**

```ts
// apps/api/src/routes/owner/review-routes.ts
import { Hono } from 'hono';
import { reviewReplyInputSchema, reviewReportCreateSchema, toReviewId } from '@meshimap/core';
import type { ReviewId } from '@meshimap/core';
import type { Context } from 'hono';

import { createDatabase } from '../../db/client';
import { buildEntityId, createUuidHex } from '../../lib/entity-id';
import { notFound } from '../../lib/http-error';
import {
  createReviewReportAsOwner,
  deleteReviewReplyAsOwner,
  listShopReviewsAsOwner,
  upsertReviewReplyAsOwner,
} from '../../repositories/owner-review-repository';
import { readJsonBody, readShopIdParam, requireOwned } from './guard';
import type { OwnerEnv } from './guard';

export const reviewRoutes = new Hono<OwnerEnv>();

/** 形式不正も 404 に畳む。readShopIdParam と同じ理由（形式の正誤を漏らさない） */
function readReviewIdParam(c: Context<OwnerEnv>): ReviewId {
  try {
    return toReviewId(c.req.param('reviewId') ?? '');
  } catch {
    throw notFound();
  }
}

reviewRoutes.get('/shops/:shopId/reviews', async (c) => {
  const reviews = await listShopReviewsAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    readShopIdParam(c),
  );
  return c.json({ reviews: requireOwned(reviews) });
});

reviewRoutes.put('/reviews/:reviewId/reply', async (c) => {
  const reviewId = readReviewIdParam(c);
  const input = await readJsonBody(c, reviewReplyInputSchema);
  const reply = await upsertReviewReplyAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    reviewId,
    input.body,
  );
  return c.json(requireOwned(reply));
});

reviewRoutes.delete('/reviews/:reviewId/reply', async (c) => {
  const isDeleted = await deleteReviewReplyAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    readReviewIdParam(c),
  );
  if (!isDeleted) {
    throw notFound();
  }
  return c.body(null, 204);
});

reviewRoutes.post('/reviews/:reviewId/report', async (c) => {
  const reviewId = readReviewIdParam(c);
  const input = await readJsonBody(c, reviewReportCreateSchema);
  // レビュー本体には触れない。判断は Phase 9 の管理者が行う
  const isCreated = await createReviewReportAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    reviewId,
    buildEntityId('report', createUuidHex()),
    input,
  );
  if (!isCreated) {
    throw notFound();
  }
  return c.body(null, 201);
});
```

`index.ts` に `ownerRoutes.route('/', reviewRoutes);` を足す。

- [ ] **Step 8: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/api -- src/routes/owner/review-routes.test.ts`
Expected: PASS（12 件）。

- [ ] **Step 9: クーポンルートのテストを書く**

```ts
// apps/api/src/routes/owner/campaign-routes.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toActor } from '../../auth/actor';
import { createMigratedD1 } from '../../db/testing/local-d1';
import type { LocalD1 } from '../../db/testing/local-d1';
import { seedTwoOwners } from '../../repositories/testing/owner-fixtures';
import { createOwnerTestApp } from '../testing/owner-app';
import type { OwnerTestApp } from '../testing/owner-app';

let local: LocalD1;
let aliceApp: OwnerTestApp;
let bobApp: OwnerTestApp;

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const validCampaign = {
  title: '開店記念',
  body: '全品 10% オフ',
  discountType: 'percent',
  discountValue: 10,
  startsOn: '2026-10-01',
  endsOn: '2026-10-31',
  status: 'published',
};

async function createCampaign(app: OwnerTestApp): Promise<{ id: string }> {
  return await (
    await app.request('/owner/shops/shp_alice/campaigns', jsonInit('POST', validCampaign))
  ).json();
}

beforeEach(async () => {
  local = await createMigratedD1();
  await seedTwoOwners(local);
  aliceApp = createOwnerTestApp(local, toActor('usr_alice', 'owner'));
  bobApp = createOwnerTestApp(local, toActor('usr_bob', 'owner'));
});

afterEach(async () => {
  await local.dispose();
});

describe('クーポン', () => {
  it('POST は 201 を返し、ID は cmp_ で始まる', async () => {
    const response = await aliceApp.request(
      '/owner/shops/shp_alice/campaigns',
      jsonInit('POST', validCampaign),
    );
    expect(response.status).toBe(201);
    const body: { id: string } = await response.json();
    expect(body.id).toMatch(/^cmp_[0-9a-f]{32}$/);
  });

  it('GET は自店のクーポン一覧を返す', async () => {
    await createCampaign(aliceApp);
    const response = await aliceApp.request('/owner/shops/shp_alice/campaigns');
    expect(response.status).toBe(200);
    const body: { campaigns: readonly unknown[] } = await response.json();
    expect(body.campaigns).toHaveLength(1);
  });

  it('終了日が開始日より前なら 422 を返す', async () => {
    const response = await aliceApp.request(
      '/owner/shops/shp_alice/campaigns',
      jsonInit('POST', { ...validCampaign, startsOn: '2026-10-31', endsOn: '2026-10-01' }),
    );
    expect(response.status).toBe(422);
  });

  it('割引率が 101% なら 422 を返す', async () => {
    const response = await aliceApp.request(
      '/owner/shops/shp_alice/campaigns',
      jsonInit('POST', { ...validCampaign, discountValue: 101 }),
    );
    expect(response.status).toBe(422);
  });

  it('PATCH は shopId を取らず campaignId だけで更新できる', async () => {
    const campaign = await createCampaign(aliceApp);
    const response = await aliceApp.request(
      `/owner/campaigns/${campaign.id}`,
      jsonInit('PATCH', { ...validCampaign, title: '改題' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ title: '改題' });
  });

  it('DELETE は 204 を返す', async () => {
    const campaign = await createCampaign(aliceApp);
    expect(
      (await aliceApp.request(`/owner/campaigns/${campaign.id}`, { method: 'DELETE' })).status,
    ).toBe(204);
  });

  it('他人のクーポンは PATCH できず 404 になり、値も変わらない', async () => {
    const campaign = await createCampaign(aliceApp);
    const response = await bobApp.request(
      `/owner/campaigns/${campaign.id}`,
      jsonInit('PATCH', { ...validCampaign, title: '乗っ取り' }),
    );
    expect(response.status).toBe(404);
    const row = await local.d1
      .prepare(`SELECT title FROM campaigns WHERE id = ?`)
      .bind(campaign.id)
      .first<{ title: string }>();
    expect(row?.title).toBe('開店記念');
  });

  it('他人のクーポンは DELETE できず 404 になり、行も残る', async () => {
    const campaign = await createCampaign(aliceApp);
    expect(
      (await bobApp.request(`/owner/campaigns/${campaign.id}`, { method: 'DELETE' })).status,
    ).toBe(404);
    const count = await local.d1
      .prepare(`SELECT count(*) AS count FROM campaigns WHERE id = ?`)
      .bind(campaign.id)
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });
});
```

- [ ] **Step 10: クーポンルートを実装し、テストを通す**

```ts
// apps/api/src/routes/owner/campaign-routes.ts
import { Hono } from 'hono';
import { campaignInputSchema } from '@meshimap/core';

import { createDatabase } from '../../db/client';
import { buildEntityId, createUuidHex } from '../../lib/entity-id';
import { notFound } from '../../lib/http-error';
import {
  createCampaignAsOwner,
  deleteCampaignAsOwner,
  listCampaignsAsOwner,
  updateCampaignAsOwner,
} from '../../repositories/owner-campaign-repository';
import { readIdParam, readJsonBody, readShopIdParam, requireOwned } from './guard';
import type { OwnerEnv } from './guard';

export const campaignRoutes = new Hono<OwnerEnv>();

campaignRoutes.get('/shops/:shopId/campaigns', async (c) => {
  const campaigns = await listCampaignsAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    readShopIdParam(c),
  );
  return c.json({ campaigns: requireOwned(campaigns) });
});

campaignRoutes.post('/shops/:shopId/campaigns', async (c) => {
  const shopId = readShopIdParam(c);
  const input = await readJsonBody(c, campaignInputSchema);
  const campaign = await createCampaignAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    shopId,
    buildEntityId('campaign', createUuidHex()),
    input,
    new Date(),
  );
  return c.json(requireOwned(campaign), 201);
});

campaignRoutes.patch('/campaigns/:campaignId', async (c) => {
  const campaignId = readIdParam(c, 'campaignId');
  const input = await readJsonBody(c, campaignInputSchema);
  const campaign = await updateCampaignAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    campaignId,
    input,
  );
  return c.json(requireOwned(campaign));
});

campaignRoutes.delete('/campaigns/:campaignId', async (c) => {
  const isDeleted = await deleteCampaignAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    readIdParam(c, 'campaignId'),
  );
  if (!isDeleted) {
    throw notFound();
  }
  return c.body(null, 204);
});
```

`index.ts` に `ownerRoutes.route('/', campaignRoutes);` を足す。

Run: `npm run test -w @meshimap/api -- src/routes/owner/campaign-routes.test.ts`
Expected: PASS（8 件）。

- [ ] **Step 11: 申請ルートのテストを書く**

```ts
// apps/api/src/routes/owner/application-routes.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toActor } from '../../auth/actor';
import { createMigratedD1 } from '../../db/testing/local-d1';
import type { LocalD1 } from '../../db/testing/local-d1';
import { seedTwoOwners } from '../../repositories/testing/owner-fixtures';
import { createOwnerTestApp } from '../testing/owner-app';
import type { OwnerTestApp } from '../testing/owner-app';

let local: LocalD1;
let aliceApp: OwnerTestApp;

function pdfFile(totalLength = 64): File {
  const bytes = new Uint8Array(totalLength);
  bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0);
  return new File([bytes], 'license.pdf', { type: 'application/pdf' });
}

async function insertApplication(status: string): Promise<void> {
  await local.d1
    .prepare(
      // shop_id は NOT NULL で shops.id を参照する（apps/api/src/db/schema/admin.ts:112-114）。
      // seedTwoOwners が作る alice の店（shp_alice）を指す。updated_at 列はこの表に無い
      `INSERT INTO shop_applications (id, applicant_id, shop_id, status, documents, review_note, created_at)
       VALUES ('app_1', 'usr_alice', 'shp_alice', ?, '[]', '営業許可証が不鮮明です', 1000)`,
    )
    .bind(status)
    .run();
}

beforeEach(async () => {
  local = await createMigratedD1();
  await seedTwoOwners(local);
  aliceApp = createOwnerTestApp(local, toActor('usr_alice', 'owner'));
});

afterEach(async () => {
  await local.dispose();
});

describe('GET /owner/application', () => {
  it('申請が無ければ application が null で 200 を返す（404 にしない）', async () => {
    const response = await aliceApp.request('/owner/application');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ application: null });
  });

  it('差し戻し中なら理由つきで返る', async () => {
    await insertApplication('returned');
    const response = await aliceApp.request('/owner/application');
    const body: { application: { status: string; reviewNote: string } } = await response.json();
    expect(body.application).toMatchObject({
      status: 'returned',
      reviewNote: '営業許可証が不鮮明です',
    });
  });
});

describe('POST /owner/application/documents', () => {
  it('PDF を追加でき 201 を返す', async () => {
    await insertApplication('returned');
    const form = new FormData();
    form.append('file', pdfFile());
    form.append('kind', 'business-license');
    const response = await aliceApp.request('/owner/application/documents', {
      method: 'POST',
      body: form,
    });
    expect(response.status).toBe(201);
    const body: { application: { documents: readonly { kind: string }[] } } = await response.json();
    expect(body.application.documents).toEqual([
      {
        kind: 'business-license',
        r2Key: expect.stringMatching(/^application-documents\/usr_alice\/[0-9a-f]{32}\.pdf$/),
      },
    ]);
  });

  it('申請がまだ無いときは 404 を返す', async () => {
    const form = new FormData();
    form.append('file', pdfFile());
    form.append('kind', 'business-license');
    expect(
      (await aliceApp.request('/owner/application/documents', { method: 'POST', body: form }))
        .status,
    ).toBe(404);
  });

  it('file フィールドが無ければ 422 を返す', async () => {
    await insertApplication('returned');
    const form = new FormData();
    form.append('kind', 'business-license');
    expect(
      (await aliceApp.request('/owner/application/documents', { method: 'POST', body: form }))
        .status,
    ).toBe(422);
  });

  it('kind が空なら 422 を返す', async () => {
    await insertApplication('returned');
    const form = new FormData();
    form.append('file', pdfFile());
    form.append('kind', '');
    expect(
      (await aliceApp.request('/owner/application/documents', { method: 'POST', body: form }))
        .status,
    ).toBe(422);
  });
});

describe('POST /owner/application/resubmit', () => {
  const resubmitInit: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note: '書類を差し替えました' }),
  };

  it('差し戻し中なら 200 を返し、状態が pending になる', async () => {
    await insertApplication('returned');
    const response = await aliceApp.request('/owner/application/resubmit', resubmitInit);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ application: { status: 'pending' } });
  });

  it('却下済みからは再提出できず 404 を返し、状態も変わらない', async () => {
    await insertApplication('rejected');
    expect((await aliceApp.request('/owner/application/resubmit', resubmitInit)).status).toBe(404);
    const row = await local.d1
      .prepare(`SELECT status FROM shop_applications WHERE id = 'app_1'`)
      .first<{ status: string }>();
    expect(row?.status).toBe('rejected');
  });

  it('審査中からも再提出できず 404 を返す（二重提出を防ぐ）', async () => {
    await insertApplication('pending');
    expect((await aliceApp.request('/owner/application/resubmit', resubmitInit)).status).toBe(404);
  });
});
```

- [ ] **Step 12: 申請ルートを実装し、テストを通す**

```ts
// apps/api/src/routes/owner/application-routes.ts
import { Hono } from 'hono';
import { applicationResubmitSchema } from '@meshimap/core';

import { createDatabase } from '../../db/client';
import { createUuidHex } from '../../lib/entity-id';
import { invalidInput } from '../../lib/http-error';
import {
  appendApplicationDocumentAsOwner,
  findLatestApplicationAsOwner,
  resubmitApplicationAsOwner,
} from '../../repositories/owner-application-repository';
import { readJsonBody, requireOwned } from './guard';
import type { OwnerEnv } from './guard';

export const applicationRoutes = new Hono<OwnerEnv>();

const UPLOAD_FIELD_NAME = 'file';
const KIND_FIELD_NAME = 'kind';

applicationRoutes.get('/application', async (c) => {
  // 申請がまだ無いのは正常な状態なので 404 にしない。
  // 「審査状況」画面はこの null を見て「未申請」と表示する
  const application = await findLatestApplicationAsOwner(createDatabase(c.env.DB), c.get('owner'));
  return c.json({ application });
});

applicationRoutes.post('/application/documents', async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get(UPLOAD_FIELD_NAME);
  const kind = form?.get(KIND_FIELD_NAME);
  if (!(file instanceof File) || typeof kind !== 'string' || kind === '') {
    throw invalidInput();
  }
  const result = await appendApplicationDocumentAsOwner(
    createDatabase(c.env.DB),
    c.env.MEDIA,
    c.get('owner'),
    createUuidHex(),
    kind,
    await file.arrayBuffer(),
  );
  const decided = requireOwned(result);
  if (!decided.ok) {
    throw invalidInput();
  }
  return c.json({ application: decided.application }, 201);
});

applicationRoutes.post('/application/resubmit', async (c) => {
  const input = await readJsonBody(c, applicationResubmitSchema);
  // returned 以外からの再提出は null が返る = 404。審査結果を申請者が覆せない
  const application = await resubmitApplicationAsOwner(
    createDatabase(c.env.DB),
    c.get('owner'),
    input.note,
    new Date(),
  );
  return c.json({ application: requireOwned(application) });
});
```

`index.ts` に `ownerRoutes.route('/', applicationRoutes);` を足す。最終形は次のとおり。

```ts
// apps/api/src/routes/owner/index.ts
import { Hono } from 'hono';

import { applicationRoutes } from './application-routes';
import { campaignRoutes } from './campaign-routes';
import { requireOwner } from './guard';
import type { OwnerEnv } from './guard';
import { menuRoutes } from './menu-routes';
import { photoRoutes } from './photo-routes';
import { reviewRoutes } from './review-routes';
import { shopRoutes } from './shop-routes';

/**
 * /owner 配下のサブアプリ。
 * requireOwner をここで 1 回だけ掛ける。各ルートファイルには権限判定を書かない
 * （書けるようにすると、書き忘れが穴になる）。
 */
export const ownerRoutes = new Hono<OwnerEnv>();

ownerRoutes.use('*', requireOwner);
ownerRoutes.route('/', shopRoutes);
ownerRoutes.route('/', photoRoutes);
ownerRoutes.route('/', menuRoutes);
ownerRoutes.route('/', reviewRoutes);
ownerRoutes.route('/', campaignRoutes);
ownerRoutes.route('/', applicationRoutes);
```

Run: `npm run test -w @meshimap/api -- src/routes/owner/application-routes.test.ts`
Expected: PASS（9 件）。

- [ ] **Step 13: `POST /shops/:shopId/views` のテストを書く**

```ts
// apps/api/src/routes/shops.test.ts に追記
describe('POST /shops/:shopId/views', () => {
  it('匿名でも 204 を返し、閲覧が記録される', async () => {
    const response = await anonymousApp.request('/shops/shp_001/views', { method: 'POST' });
    expect(response.status).toBe(204);
    const row = await local.d1
      .prepare(`SELECT view_count FROM shop_daily_stats WHERE shop_id = 'shp_001'`)
      .first<{ view_count: number }>();
    expect(row?.view_count).toBe(1);
  });

  it('存在しない店舗でも 204 を返す（存在有無が漏れない）', async () => {
    const response = await anonymousApp.request('/shops/shp_nowhere/views', { method: 'POST' });
    expect(response.status).toBe(204);
  });

  it('存在しない店舗では行が増えない', async () => {
    await anonymousApp.request('/shops/shp_nowhere/views', { method: 'POST' });
    const count = await local.d1
      .prepare(`SELECT count(*) AS count FROM shop_daily_stats`)
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it('形式が不正な店舗 ID でも 204 を返す（422 を返すと形式の正誤が漏れる）', async () => {
    const response = await anonymousApp.request(`/shops/${encodeURIComponent('shp_あ')}/views`, {
      method: 'POST',
    });
    expect(response.status).toBe(204);
  });

  it('3 回押すと 3 件として数えられる', async () => {
    for (let index = 0; index < 3; index += 1) {
      await anonymousApp.request('/shops/shp_001/views', { method: 'POST' });
    }
    const row = await local.d1
      .prepare(`SELECT view_count FROM shop_daily_stats WHERE shop_id = 'shp_001'`)
      .first<{ view_count: number }>();
    expect(row?.view_count).toBe(3);
  });
});
```

**`anonymousApp` は Phase 6 の `shops.test.ts` が既に用意しているヘルパを使う。** 無ければ `createOwnerTestApp` と同じ形（`Hono<AppEnv>` に `viewer` を注入し、`/shops` をマウントする）でこのファイル内に作る。

- [ ] **Step 14: `POST /shops/:shopId/views` を実装する**

```ts
// apps/api/src/routes/shops.ts に追記
import { recordShopView } from '../repositories/shop-stats-repository';

/**
 * 店舗詳細の閲覧記録。公開エンドポイント。
 * 常に 204 を返す。404 を返すと「この ID の店は存在しない」が誰にでも分かる列挙経路になる。
 * 存在しない shopId は recordShopView が外部キー違反を握って何もしない。
 */
shopRoutes.post('/shops/:shopId/views', async (c) => {
  await recordShopView(createDatabase(c.env.DB), c.req.param('shopId') ?? '', new Date());
  return c.body(null, 204);
});
```

Run: `npm run test -w @meshimap/api -- src/routes/shops.test.ts`
Expected: PASS。

- [ ] **Step 15: `/owner` を本体アプリにマウントする**

`apps/api/src/index.ts`（Phase 4 が作成）に 2 行足す。

```ts
import { ownerRoutes } from './routes/owner';
// ...（既存の app.route(...) の並びの末尾に）
app.route('/owner', ownerRoutes);
```

Run: `grep -n "app.route" apps/api/src/index.ts`
Expected: `/owner` を含む行が出る。

- [ ] **Step 16: 権限マトリクスに 32 行を追加する（失敗する状態にする）**

Phase 4 Task 4-12 の `ENDPOINT_CASES` に、本計画書の「権限マトリクス」表の #14〜#45（32 行）をそのまま追加する。

```ts
// apps/api/src/routes/permission-matrix.test.ts の ENDPOINT_CASES に追記
  // ── Phase 8: 店舗管理者 ──
  { method: 'GET', path: '/owner/shops', anonymous: 401, user: 403, admin: 403, owner: 200 },
  { method: 'GET', path: '/owner/shops/:shopId/stats', anonymous: 401, user: 403, admin: 403, owner: 200, otherOwner: 404 },
  { method: 'GET', path: '/owner/shops/:shopId/location', anonymous: 401, user: 403, admin: 403, owner: 200, otherOwner: 404 },
  { method: 'GET', path: '/owner/shops/:shopId/hours', anonymous: 401, user: 403, admin: 403, owner: 200, otherOwner: 404 },
  { method: 'PUT', path: '/owner/shops/:shopId/hours', anonymous: 401, user: 403, admin: 403, owner: 200, otherOwner: 404 },
  { method: 'POST', path: '/owner/shops/:shopId/closures', anonymous: 401, user: 403, admin: 403, owner: 201, otherOwner: 404 },
  { method: 'DELETE', path: '/owner/shops/:shopId/closures/:closureId', anonymous: 401, user: 403, admin: 403, owner: 204, otherOwner: 404 },
  { method: 'GET', path: '/owner/shops/:shopId/photos', anonymous: 401, user: 403, admin: 403, owner: 200, otherOwner: 404 },
  { method: 'POST', path: '/owner/shops/:shopId/photos', anonymous: 401, user: 403, admin: 403, owner: 201, otherOwner: 404 },
  { method: 'PATCH', path: '/owner/shops/:shopId/photos/:photoId', anonymous: 401, user: 403, admin: 403, owner: 200, otherOwner: 404 },
  { method: 'PUT', path: '/owner/shops/:shopId/photo-order', anonymous: 401, user: 403, admin: 403, owner: 200, otherOwner: 404 },
  { method: 'DELETE', path: '/owner/shops/:shopId/photos/:photoId', anonymous: 401, user: 403, admin: 403, owner: 204, otherOwner: 404 },
  { method: 'GET', path: '/owner/shops/:shopId/menu', anonymous: 401, user: 403, admin: 403, owner: 200, otherOwner: 404 },
  { method: 'POST', path: '/owner/shops/:shopId/menu/categories', anonymous: 401, user: 403, admin: 403, owner: 201, otherOwner: 404 },
  { method: 'DELETE', path: '/owner/shops/:shopId/menu/categories/:categoryId', anonymous: 401, user: 403, admin: 403, owner: 204, otherOwner: 404 },
  { method: 'POST', path: '/owner/shops/:shopId/menu/items', anonymous: 401, user: 403, admin: 403, owner: 201, otherOwner: 404 },
  { method: 'PATCH', path: '/owner/shops/:shopId/menu/items/:menuItemId', anonymous: 401, user: 403, admin: 403, owner: 200, otherOwner: 404 },
  { method: 'DELETE', path: '/owner/shops/:shopId/menu/items/:menuItemId', anonymous: 401, user: 403, admin: 403, owner: 204, otherOwner: 404 },
  { method: 'GET', path: '/owner/shops/:shopId/seats', anonymous: 401, user: 403, admin: 403, owner: 200, otherOwner: 404 },
  { method: 'PUT', path: '/owner/shops/:shopId/seats', anonymous: 401, user: 403, admin: 403, owner: 200, otherOwner: 404 },
  { method: 'GET', path: '/owner/shops/:shopId/reviews', anonymous: 401, user: 403, admin: 403, owner: 200, otherOwner: 404 },
  { method: 'PUT', path: '/owner/reviews/:reviewId/reply', anonymous: 401, user: 403, admin: 403, owner: 200, otherOwner: 404 },
  { method: 'DELETE', path: '/owner/reviews/:reviewId/reply', anonymous: 401, user: 403, admin: 403, owner: 204, otherOwner: 404 },
  { method: 'POST', path: '/owner/reviews/:reviewId/report', anonymous: 401, user: 403, admin: 403, owner: 201, otherOwner: 404 },
  { method: 'GET', path: '/owner/shops/:shopId/campaigns', anonymous: 401, user: 403, admin: 403, owner: 200, otherOwner: 404 },
  { method: 'POST', path: '/owner/shops/:shopId/campaigns', anonymous: 401, user: 403, admin: 403, owner: 201, otherOwner: 404 },
  { method: 'PATCH', path: '/owner/campaigns/:campaignId', anonymous: 401, user: 403, admin: 403, owner: 200, otherOwner: 404 },
  { method: 'DELETE', path: '/owner/campaigns/:campaignId', anonymous: 401, user: 403, admin: 403, owner: 204, otherOwner: 404 },
  { method: 'GET', path: '/owner/application', anonymous: 401, user: 403, admin: 403, owner: 200 },
  { method: 'POST', path: '/owner/application/documents', anonymous: 401, user: 403, admin: 403, owner: 201 },
  { method: 'POST', path: '/owner/application/resubmit', anonymous: 401, user: 403, admin: 403, owner: 200 },
  { method: 'POST', path: '/shops/:shopId/views', anonymous: 204, user: 204, admin: 204, owner: 204 },
```

**Phase 4 が定義した実際のプロパティ名（`anonymous` / `user` / `admin` / `owner` / `otherOwner`）に合わせること。** 名前が違えば型エラーになるので、`apps/api/src/routes/permission-matrix.test.ts` の既存行を 1 行読んで形を合わせる。

**`DELEGATED_ROUTE_PATTERNS` には 1 行も足さない。** Phase 8 の 32 本は主体ごとの総当たりをこの `ENDPOINT_CASES` 自身が持つので、委譲先が存在しない（「権限マトリクス」節の「Phase 8 は委譲しない」を参照）。

Run: `npm run test -w @meshimap/api -- src/routes/permission-matrix.test.ts`
Expected: FAIL が 1 本だけ残る。Step 15 で `/owner` をマウントした時点で 2 本落ちていたうち、「権限マトリクスは app のエンドポイントを 1 本残らず覆っている」はこの Step で緑になり（`covered` に 32 本が入った）、「app に登録されたエンドポイントは 19 本で、想定どおりの並びである」だけが `Expected 19 items / Received 51 items` で落ち続ける。次の Step で解消する。

- [ ] **Step 17: `EXPECTED_ROUTE_PATTERNS` を更新してテストを通す**

直すのは 2 か所だけである。**`DELEGATED_ROUTE_PATTERNS` と `DELEGATABLE_PATH_PATTERN` には触らない**（Phase 8 は委譲しない。「権限マトリクス」節の「Phase 8 は委譲しない」を参照）。

**(1) `EXPECTED_ROUTE_PATTERNS` に 32 本足して 51 本にする。**

**この配列は `collectEndpointPatterns` が `.sort()` した結果と `toEqual` で比較される**（実物 `apps/api/src/routes/permission-matrix.test.ts` の `collectEndpointPatterns` が `[...new Set(patterns)].sort()` を返す）。したがって **`ENDPOINT_CASES` の並びをそのまま末尾に貼ってはならない。配列全体が昇順**でなければならない。`/owner` は `/health` `/me` より大きく `/reservation-slots` `/reservations` `/reviews` `/shops` より小さいので、**メソッド群ごとに既存行のあいだへ差し込む**形になる。

Phase 7 まで済ませた前提での完成形（51 本）:

```ts
/** 権限マトリクスが責任を持つ 51 本。ここを増減させるときは必ず ENDPOINT_CASES も直す */
const EXPECTED_ROUTE_PATTERNS: readonly string[] = [
  'DELETE /owner/campaigns/:campaignId',
  'DELETE /owner/reviews/:reviewId/reply',
  'DELETE /owner/shops/:shopId/closures/:closureId',
  'DELETE /owner/shops/:shopId/menu/categories/:categoryId',
  'DELETE /owner/shops/:shopId/menu/items/:menuItemId',
  'DELETE /owner/shops/:shopId/photos/:photoId',
  'DELETE /reviews/:reviewId',
  'DELETE /shops/:shopId',
  'GET /health',
  'GET /me',
  'GET /owner/application',
  'GET /owner/reservations',
  'GET /owner/reservations/:reservationId',
  'GET /owner/shops',
  'GET /owner/shops/:shopId/campaigns',
  'GET /owner/shops/:shopId/hours',
  'GET /owner/shops/:shopId/location',
  'GET /owner/shops/:shopId/menu',
  'GET /owner/shops/:shopId/photos',
  'GET /owner/shops/:shopId/reviews',
  'GET /owner/shops/:shopId/seats',
  'GET /owner/shops/:shopId/stats',
  'GET /reservation-slots',
  'GET /reservations',
  'GET /reservations/:reservationId',
  'GET /shops',
  'GET /shops/:shopId',
  'GET /shops/:shopId/reviews',
  'PATCH /owner/campaigns/:campaignId',
  'PATCH /owner/reservations/:reservationId/memo',
  'PATCH /owner/shops/:shopId/menu/items/:menuItemId',
  'PATCH /owner/shops/:shopId/photos/:photoId',
  'PATCH /shops/:shopId',
  'POST /owner/application/documents',
  'POST /owner/application/resubmit',
  'POST /owner/reservations/:reservationId/status',
  'POST /owner/reviews/:reviewId/report',
  'POST /owner/shops/:shopId/campaigns',
  'POST /owner/shops/:shopId/closures',
  'POST /owner/shops/:shopId/menu/categories',
  'POST /owner/shops/:shopId/menu/items',
  'POST /owner/shops/:shopId/photos',
  'POST /reservations',
  'POST /reservations/:reservationId/cancel',
  'POST /shops',
  'POST /shops/:shopId/reviews',
  'POST /shops/:shopId/views',
  'PUT /owner/reviews/:reviewId/reply',
  'PUT /owner/shops/:shopId/hours',
  'PUT /owner/shops/:shopId/photo-order',
  'PUT /owner/shops/:shopId/seats',
];
```

**(2) it の名前の数字を 51 に直す。**

```ts
it('app に登録されたエンドポイントは 51 本で、想定どおりの並びである', () => {
  expect(declaredRoutePatterns()).toEqual(EXPECTED_ROUTE_PATTERNS);
});
```

Phase 7 がこの名前を既に 19 に直しているので、19 → 51 の書き換えになる。**名前と中身がずれたテストは、次に読む人を必ず騙す。**

`describe('ルート表と実装の突合')` の中の残り 3 本（「走査対象のエンドポイントが 1 本以上ある」「権限マトリクスは app のエンドポイントを 1 本残らず覆っている」「委譲しているのは予約系だけで、予約系は 1 本残らず委譲されている」）は**そのまま**でよい。とくに 3 本目は `DELEGATABLE_PATH_PATTERN` に一致するルートだけを数えるので、Phase 8 の 32 本が増えても 9 本 vs 9 本のまま緑である。

Run: `npm run test -w @meshimap/api`
Expected: PASS。API のすべてのテストが緑になる。

**FAIL したときの読み方は 3 通りしかない。**

| 落ち方                                                   | 意味                                                              | 直し方                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| `Expected 51 items / Received 51 items` なのに差分が出る | 並びが昇順になっていない（末尾に貼った）                          | 上の完成形をそのまま使う                                             |
| `権限マトリクスに無いエンドポイント: ...`                | `ENDPOINT_CASES` への追記漏れ（Step 16 の取りこぼし）             | `ENDPOINT_CASES` に足す。**`DELEGATED_ROUTE_PATTERNS` に逃がさない** |
| 「委譲しているのは予約系だけで…」が落ちる                | `DELEGATED_ROUTE_PATTERNS` か `DELEGATABLE_PATH_PATTERN` を触った | 触った行を元に戻す。Phase 8 はこの 2 つを変更しない                  |

- [ ] **Step 18: わざと壊して検証が効いていることを確認する**

`apps/api/src/routes/owner/index.ts` の `ownerRoutes.route('/', menuRoutes);` を削除する。

Run: `npm run test -w @meshimap/api -- src/routes`
Expected: FAIL。`menu-routes.test.ts` の 12 件が 404 で落ちるうえ、`permission-matrix.test.ts` が「`EXPECTED_ROUTE_PATTERNS` にあるのに実装されていないルートがある」で落ちる。**突合テストが配線漏れを検出できることを、実際に落として確認する。**

次に `shops.ts` の `POST /shops/:shopId/views` で `return c.body(null, 204)` を `throw notFound()` に変える（存在しない店で 404 を返す実装に退行させる）。
Expected: FAIL。「存在しない店舗でも 204 を返す（存在有無が漏れない）」「形式が不正な店舗 ID でも 204 を返す」が落ちる。

**両方確認したら元に戻し、再度テストが緑になることを確認する。**

- [ ] **Step 19: 型・lint・ミューテーションを通す**

Run: `npm run typecheck -w @meshimap/api && npm run lint && npm run test:mutation -w @meshimap/api`
Expected: 型・lint は成功、ミューテーションスコア 85 以上。ルート層で生き残りやすいのは `c.json(x, 201)` の `201` → `200` のような状態コード変異なので、**各 POST のテストで `expect(response.status).toBe(201)` を必ず書いてある**ことを確認する。生き残った変異があれば殺せるテストを足す。**除外は選択肢にない。**

- [ ] **Step 20: コミット**

```bash
git add apps/api/src/routes apps/api/src/index.ts
git commit -m "feat(api): メニュー・レビュー・クーポン・申請ルートと閲覧記録を追加し権限マトリクスを拡張"
```

---

## Task 8-15: モバイル `features/owner`（応答スキーマ・API 関数・Query フック）

**Files:**

- Create: `apps/mobile/src/constants/owner.ts`
- Create: `apps/mobile/src/constants/owner.test.ts`
- Create: `apps/mobile/src/features/owner/types.ts`
- Create: `apps/mobile/src/features/owner/types.test.ts`
- Create: `apps/mobile/src/features/owner/api.ts`
- Create: `apps/mobile/src/features/owner/api.test.ts`
- Create: `apps/mobile/src/features/owner/queries.ts`
- Create: `apps/mobile/src/features/owner/queries.test.tsx`
- Create: `apps/mobile/src/features/owner/testing/query-wrapper.tsx`

**Interfaces:**

- Consumes: `API_BASE_URL` / `API_TIMEOUT_MS`（`src/constants/api.ts`、実ファイルで確認済み）、`HTTP_STATUS`（`src/constants/http.ts`、`unauthorized` / `forbidden` / `conflict` / `tooManyRequests` の 4 キーのみ。**`notFound` は無いので Phase 8 で足す**）、Phase 5 の認証付き `fetch` ラッパ（`features/auth/api.ts`）
- Produces:
  - `constants/owner.ts`: `STATS_RANGE_OPTIONS: readonly { days: StatsRangeDays; label: string }[]`、`KPI_LABELS`、`SHOP_PHOTO_MAX_COUNT = 20`、`NEW_ENTITY_ROUTE_SEGMENT = 'new'`
  - `features/owner/types.ts`: `ownedShopSchema` / `shopStatsSchema` / `shopHoursSchema` / `shopPhotoSchema` / `menuTreeSchema` / `ownerReviewSchema` / `campaignSchema` / `shopApplicationSchema` と、それぞれの `z.infer` 型（`OwnedShop`, `ShopStats`, …）
  - `features/owner/api.ts`: `fetchOwnedShops()`, `fetchShopStats(shopId, days)`, `fetchShopHours(shopId)`, `saveShopHours(shopId, input)`, `createClosure(...)`, `deleteClosure(...)`, `fetchShopPhotos(shopId)`, `uploadShopPhoto(shopId, asset)`, `updateShopPhoto(...)`, `reorderShopPhotos(...)`, `deleteShopPhoto(...)`, `fetchShopSeats`, `saveShopSeats`, `fetchMenuTree`, `createMenuCategory`, `deleteMenuCategory`, `createMenuItem`, `updateMenuItem`, `deleteMenuItem`, `fetchOwnerReviews`, `saveReviewReply`, `deleteReviewReply`, `reportReview`, `fetchCampaigns`, `createCampaign`, `updateCampaign`, `deleteCampaign`, `fetchApplication`, `uploadApplicationDocument`, `resubmitApplication`
  - `features/owner/queries.ts`: `ownerQueryKeys`（オブジェクト）と `useOwnedShops` / `useShopStats` / `useShopHours` / `useShopPhotos` / `useMenuTree` / `useOwnerReviews` / `useCampaigns` / `useApplication` / 対応する `useMutation` フック群
  - `features/owner/testing/query-wrapper.tsx`: `createQueryWrapper(): { wrapper: FC<{ children: ReactNode }>; client: QueryClient }`

### `fetch` をここにしか書かない理由（`CODING_GUIDELINES.md` §4）

コーディング規約は「`fetch` を呼んでよいのは `features/*/api.ts` だけ」と定めている。画面から直接 `fetch` すると、認証 Cookie を載せ忘れた呼び出しや、Zod を通さない生の JSON がコンポーネントに入り込む経路ができる。`api.ts` を単一の出入口にすれば、**「サーバの応答を信用しない」判断を 1 ファイルで完結させられる。**

### 応答を Zod で受け直す理由

API とモバイルは同じリポジトリにあるが、**デプロイのタイミングは別**である。古いアプリが新しい API を叩く状況は必ず起きる。`z.parse` を通していれば、形が変わったときに「画面のどこかで `undefined.map is not a function`」ではなく「`api.ts` の parse で例外」として落ちる。落ちる場所が固定されるので、`ErrorState` に繋ぎやすい。

`packages/core` の**入力**スキーマ（Task 8-3）とは別物である。入力スキーマは「クライアントがサーバに送ってよい形」、こちらは「サーバから返ってきた形」。同じ名前にすると混ざるので、応答側は `*Schema`、入力側は `*InputSchema` / `*CreateSchema` と接尾辞で区別する。

- [ ] **Step 1: `constants/owner.ts` の失敗するテストを書く**

```tsx
// apps/mobile/src/constants/owner.test.ts
import { describe, expect, it } from '@jest/globals';

import {
  KPI_LABELS,
  NEW_ENTITY_ROUTE_SEGMENT,
  SHOP_PHOTO_MAX_COUNT,
  STATS_RANGE_OPTIONS,
} from './owner';

describe('STATS_RANGE_OPTIONS', () => {
  it('7 / 30 / 90 日の 3 択を、API が受け付ける順で持つ', () => {
    expect(STATS_RANGE_OPTIONS.map((option) => option.days)).toEqual([7, 30, 90]);
  });

  it('すべての選択肢に日本語ラベルがある', () => {
    expect(STATS_RANGE_OPTIONS.map((option) => option.label)).toEqual([
      '7日間',
      '30日間',
      '90日間',
    ]);
  });
});

describe('KPI_LABELS', () => {
  it('ダッシュボードの 4 指標ぶんのラベルを持つ', () => {
    expect(Object.keys(KPI_LABELS)).toEqual(['views', 'favorites', 'reservations', 'ratings']);
  });
});

describe('画面側の上限値', () => {
  it('写真の上限は 20 枚', () => {
    expect(SHOP_PHOTO_MAX_COUNT).toBe(20);
  });

  it('新規作成を表す URL セグメントは new', () => {
    expect(NEW_ENTITY_ROUTE_SEGMENT).toBe('new');
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/mobile -- src/constants/owner.test.ts`
Expected: FAIL。`Cannot find module './owner'`。

- [ ] **Step 3: `constants/owner.ts` を実装する**

```ts
// apps/mobile/src/constants/owner.ts
import { STATS_RANGE_DAYS } from '@meshimap/core';
import type { StatsRangeDays } from '@meshimap/core';

export interface StatsRangeOption {
  readonly days: StatsRangeDays;
  readonly label: string;
}

/**
 * 期間セグメントの選択肢。
 * days は API の `?days=` にそのまま載る値で、@meshimap/core の STATS_RANGE_DAYS が唯一の定義元。
 * ここで [7, 30, 90] を再定義すると、API 側の許容値を広げたときに画面だけ取り残される。
 */
export const STATS_RANGE_OPTIONS: readonly StatsRangeOption[] = STATS_RANGE_DAYS.map((days) => ({
  days,
  label: `${days}日間`,
}));

/** ダッシュボードの KPI ラベル。API の ShopStatsSummary のキーと 1 対 1 で対応する */
export const KPI_LABELS = {
  views: '閲覧数',
  favorites: 'お気に入り',
  reservations: '予約',
  ratings: '平均評価',
} as const;

/** 1 店舗あたりの写真上限。これを超えたら「追加」ボタンを isDisabled にする */
export const SHOP_PHOTO_MAX_COUNT = 20;

/** `[menuItemId]` / `[campaignId]` が新規作成を意味するときの値 */
export const NEW_ENTITY_ROUTE_SEGMENT = 'new';
```

**`STATS_RANGE_DAYS` は Task 8-11 で `apps/api/src/lib/stats-range.ts` に置いた。モバイルから API の内部モジュールは import できないので、Task 8-3 で `packages/core/src/stats.ts` に移し、API 側はそこから再 export する形にしておく。** Task 8-3 を実装する担当者はこの依存を見落としやすいので、`packages/core/src/index.test.ts` の export 一覧に `STATS_RANGE_DAYS` と `StatsRangeDays` を入れて固定する。

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/mobile -- src/constants/owner.test.ts`
Expected: PASS（5 件）。

- [ ] **Step 5: 応答スキーマの失敗するテストを書く**

```ts
// apps/mobile/src/features/owner/types.test.ts
import { describe, expect, it } from '@jest/globals';

import {
  campaignSchema,
  menuTreeSchema,
  ownedShopSchema,
  shopApplicationSchema,
  shopStatsSchema,
} from './types';

describe('ownedShopSchema', () => {
  it('API の応答をそのまま通す', () => {
    const parsed = ownedShopSchema.parse({
      id: 'shp_001',
      name: 'ラーメン太郎',
      status: 'published',
      ratingAvg: 4.2,
      ratingCount: 31,
    });
    expect(parsed.name).toBe('ラーメン太郎');
  });

  it('ratingCount が文字列なら弾く（サーバの形が変わったことに気づけるようにする）', () => {
    expect(() =>
      ownedShopSchema.parse({
        id: 'shp_001',
        name: 'x',
        status: 'published',
        ratingAvg: 4.2,
        ratingCount: '31',
      }),
    ).toThrow();
  });

  it('知らないキーが増えていても通す（API の前方互換を壊さない）', () => {
    const parsed = ownedShopSchema.parse({
      id: 'shp_001',
      name: 'x',
      status: 'published',
      ratingAvg: 0,
      ratingCount: 0,
      unknownFutureField: true,
    });
    expect(parsed.id).toBe('shp_001');
  });
});

describe('shopStatsSchema', () => {
  const emptySeries = { points: [], total: 0, previousTotal: 0, changeRate: null };

  it('changeRate が null でも通る（前期間が 0 のとき）', () => {
    const parsed = shopStatsSchema.parse({
      days: 7,
      views: emptySeries,
      favorites: emptySeries,
      reservations: emptySeries,
      ratings: emptySeries,
    });
    expect(parsed.views.changeRate).toBeNull();
  });

  it('points の date は YYYY-MM-DD 形式でなければ弾く', () => {
    expect(() =>
      shopStatsSchema.parse({
        days: 7,
        views: { ...emptySeries, points: [{ date: '2026/09/15', value: 1 }] },
        favorites: emptySeries,
        reservations: emptySeries,
        ratings: emptySeries,
      }),
    ).toThrow();
  });

  it('days が 14 なら弾く（API が返すのは 7/30/90 だけ）', () => {
    expect(() =>
      shopStatsSchema.parse({
        days: 14,
        views: emptySeries,
        favorites: emptySeries,
        reservations: emptySeries,
        ratings: emptySeries,
      }),
    ).toThrow();
  });
});

describe('menuTreeSchema', () => {
  it('カテゴリが空配列でも通る', () => {
    expect(menuTreeSchema.parse({ categories: [] }).categories).toEqual([]);
  });

  it('items が無いカテゴリは弾く（空配列を返す契約なので undefined は異常）', () => {
    expect(() =>
      menuTreeSchema.parse({ categories: [{ id: 'mnc_1', name: 'ランチ', sortOrder: 0 }] }),
    ).toThrow();
  });
});

describe('campaignSchema', () => {
  it('discountType は percent / yen / gift のみ', () => {
    expect(() =>
      campaignSchema.parse({
        id: 'cmp_1',
        title: 'x',
        body: 'y',
        discountType: 'free',
        discountValue: 1,
        startsOn: '2026-10-01',
        endsOn: '2026-10-02',
        status: 'published',
      }),
    ).toThrow();
  });
});

describe('shopApplicationSchema', () => {
  it('status は pending / approved / rejected / returned の 4 値', () => {
    const statuses = ['pending', 'approved', 'rejected', 'returned'];
    for (const status of statuses) {
      const parsed = shopApplicationSchema.parse({
        id: 'app_1',
        status,
        reviewNote: null,
        documents: [],
        updatedAt: '2026-09-15T00:00:00.000Z',
      });
      expect(parsed.status).toBe(status);
    }
  });

  it('draft は弾く（Phase 5 の 3 値から増えたのは 4 値まで）', () => {
    expect(() =>
      shopApplicationSchema.parse({
        id: 'app_1',
        status: 'draft',
        reviewNote: null,
        documents: [],
        updatedAt: '2026-09-15T00:00:00.000Z',
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 6: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/mobile -- src/features/owner/types.test.ts`
Expected: FAIL。`Cannot find module './types'`。

- [ ] **Step 7: 応答スキーマを実装する**

```ts
// apps/mobile/src/features/owner/types.ts
import { STATS_RANGE_DAYS } from '@meshimap/core';
import { z } from 'zod';

/** API が返す日付は必ず YYYY-MM-DD。形式を固定しておくと、グラフの軸ラベル生成で分岐が増えない */
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ownedShopSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  ratingAvg: z.number(),
  ratingCount: z.number().int(),
});
export type OwnedShop = z.infer<typeof ownedShopSchema>;

const dailyPointSchema = z.object({ date: isoDateSchema, value: z.number() });
export type DailyPoint = z.infer<typeof dailyPointSchema>;

const metricSeriesSchema = z.object({
  points: z.array(dailyPointSchema),
  total: z.number(),
  previousTotal: z.number(),
  /** 前期間が 0 のときは割合を定義できないので null。0 と混同しないため nullable にする */
  changeRate: z.number().nullable(),
});
export type MetricSeries = z.infer<typeof metricSeriesSchema>;

export const shopStatsSchema = z.object({
  days: z.union([
    z.literal(STATS_RANGE_DAYS[0]),
    z.literal(STATS_RANGE_DAYS[1]),
    z.literal(STATS_RANGE_DAYS[2]),
  ]),
  views: metricSeriesSchema,
  favorites: metricSeriesSchema,
  reservations: metricSeriesSchema,
  ratings: metricSeriesSchema,
});
export type ShopStats = z.infer<typeof shopStatsSchema>;

const shopHourSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  openTime: z.string().nullable(),
  closeTime: z.string().nullable(),
  isClosed: z.boolean(),
});
const shopClosureSchema = z.object({
  id: z.string(),
  closedOn: isoDateSchema,
  reason: z.string().nullable(),
});
export const shopHoursSchema = z.object({
  hours: z.array(shopHourSchema),
  closures: z.array(shopClosureSchema),
});
export type ShopHours = z.infer<typeof shopHoursSchema>;
export type ShopHour = z.infer<typeof shopHourSchema>;
export type ShopClosure = z.infer<typeof shopClosureSchema>;

export const shopPhotoSchema = z.object({
  id: z.string(),
  url: z.string(),
  caption: z.string().nullable(),
  sortOrder: z.number().int(),
  isCover: z.boolean(),
});
export type ShopPhoto = z.infer<typeof shopPhotoSchema>;
export const shopPhotoListSchema = z.object({ photos: z.array(shopPhotoSchema) });

export const menuItemSchema = z.object({
  id: z.string(),
  categoryId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  priceYen: z.number().int(),
  isRecommended: z.boolean(),
  // 並び順はサーバが決めるが、編集フォームが PATCH で同じ値を送り返す必要があるので受け取る
  sortOrder: z.number().int(),
});
export type MenuItem = z.infer<typeof menuItemSchema>;

export const menuTreeSchema = z.object({
  categories: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      sortOrder: z.number().int(),
      // 空カテゴリでも API は [] を返す契約。undefined を許すと画面側に ?? [] が散る
      items: z.array(menuItemSchema),
    }),
  ),
});
export type MenuTree = z.infer<typeof menuTreeSchema>;

export const ownerReviewSchema = z.object({
  review: z.object({
    id: z.string(),
    rating: z.number().int().min(1).max(5),
    body: z.string(),
    createdAt: z.string(),
    authorName: z.string(),
  }),
  reply: z.object({ body: z.string(), updatedAt: z.string() }).nullable(),
});
export type OwnerReview = z.infer<typeof ownerReviewSchema>;
export const ownerReviewListSchema = z.object({ reviews: z.array(ownerReviewSchema) });

export const campaignSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  // 値の一覧は apps/api/src/db/constants.ts の DISCOUNT_TYPES / CAMPAIGN_STATUSES が定義元
  //（`apps/api` はモバイルから import できないので写しを置く）。
  // ズレは Task 8-23 の突合テスト（マイグレーション本文と突き合わせる）で検出する
  discountType: z.enum(['percent', 'yen', 'gift']),
  discountValue: z.number().int(),
  startsOn: isoDateSchema,
  endsOn: isoDateSchema,
  status: z.enum(['draft', 'published', 'ended']),
});
export type Campaign = z.infer<typeof campaignSchema>;
export const campaignListSchema = z.object({ campaigns: z.array(campaignSchema) });

export const shopApplicationSchema = z.object({
  id: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'returned']),
  reviewNote: z.string().nullable(),
  documents: z.array(z.object({ kind: z.string(), r2Key: z.string() })),
  updatedAt: z.string(),
});
export type ShopApplication = z.infer<typeof shopApplicationSchema>;
/** 未申請は application: null。404 ではないので、画面側は null を「未申請」として描く */
export const shopApplicationResponseSchema = z.object({
  application: shopApplicationSchema.nullable(),
});

export const shopSeatsSchema = z.object({
  seatCount: z.number().int().min(0),
  hasCounter: z.boolean(),
  hasPrivateRoom: z.boolean(),
  smokingPolicy: z.enum(['no-smoking', 'smoking-area', 'smoking-allowed']),
});
export type ShopSeats = z.infer<typeof shopSeatsSchema>;
```

**`z.object` は既定で未知キーを落とす（strip）ので、「知らないキーが増えていても通す」テストはそのまま通る。`.strict()` を付けてはならない** — 付けると API にフィールドが 1 つ増えただけで既存アプリが全画面エラーになる。

- [ ] **Step 8: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/mobile -- src/features/owner/types.test.ts`
Expected: PASS（10 件）。

- [ ] **Step 9: API 関数の失敗するテストを書く**

```ts
// apps/mobile/src/features/owner/api.test.ts
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { fetchOwnedShops, fetchShopStats, OwnerApiError, uploadShopPhoto } from './api';

const originalFetch = global.fetch;
const mockFetch = jest.fn<typeof fetch>();

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  global.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockReset();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('fetchOwnedShops', () => {
  it('shops を取り出して返す', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        shops: [{ id: 'shp_1', name: 'x', status: 'published', ratingAvg: 0, ratingCount: 0 }],
      }),
    );
    await expect(fetchOwnedShops()).resolves.toHaveLength(1);
  });

  it('credentials: include で呼ぶ（Cookie が載らないと 401 になる）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ shops: [] }));
    await fetchOwnedShops();
    const [, init] = mockFetch.mock.calls[0] ?? [];
    expect(init).toMatchObject({ credentials: 'include' });
  });

  it('401 なら status つきの OwnerApiError を投げる', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ error: { status: 401, message: 'ログインが必要です' } }, 401),
    );
    await expect(fetchOwnedShops()).rejects.toMatchObject({ status: 401 });
  });

  it('404 なら status 404 の OwnerApiError を投げる', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ error: { status: 404, message: '対象が見つかりません' } }, 404),
    );
    await expect(fetchOwnedShops()).rejects.toBeInstanceOf(OwnerApiError);
  });

  it('応答の形が契約と違えば投げる（shops が配列でない）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ shops: null }));
    await expect(fetchOwnedShops()).rejects.toThrow();
  });

  it('本文が JSON でなくても OwnerApiError になる（HTML のエラーページが返ったとき）', async () => {
    mockFetch.mockResolvedValue(new Response('<html>502</html>', { status: 502 }));
    await expect(fetchOwnedShops()).rejects.toMatchObject({ status: 502 });
  });
});

describe('fetchShopStats', () => {
  it('days をクエリ文字列に載せる', async () => {
    const emptySeries = { points: [], total: 0, previousTotal: 0, changeRate: null };
    mockFetch.mockResolvedValue(
      jsonResponse({
        days: 30,
        views: emptySeries,
        favorites: emptySeries,
        reservations: emptySeries,
        ratings: emptySeries,
      }),
    );
    await fetchShopStats('shp_1', 30);
    const [url] = mockFetch.mock.calls[0] ?? [];
    expect(String(url)).toContain('/owner/shops/shp_1/stats?days=30');
  });

  it('店舗 ID を URL エンコードする（パス区切りを持ち込ませない）', async () => {
    const emptySeries = { points: [], total: 0, previousTotal: 0, changeRate: null };
    mockFetch.mockResolvedValue(
      jsonResponse({
        days: 7,
        views: emptySeries,
        favorites: emptySeries,
        reservations: emptySeries,
        ratings: emptySeries,
      }),
    );
    await fetchShopStats('shp_1/../admin', 7);
    const [url] = mockFetch.mock.calls[0] ?? [];
    expect(String(url)).toContain('shp_1%2F..%2Fadmin');
  });
});

describe('uploadShopPhoto', () => {
  it('multipart で送る（Content-Type は自分で付けない）', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        {
          id: 'pht_1',
          url: 'https://example.test/a.jpg',
          caption: null,
          sortOrder: 0,
          isCover: true,
        },
        201,
      ),
    );
    await uploadShopPhoto('shp_1', {
      uri: 'file:///tmp/a.jpg',
      mimeType: 'image/jpeg',
      fileName: 'a.jpg',
    });
    const [, init] = mockFetch.mock.calls[0] ?? [];
    expect(init?.body).toBeInstanceOf(FormData);
    // boundary はランタイムが決めるので、自前で content-type を付けると壊れる
    expect(init?.headers).toBeUndefined();
  });
});
```

- [ ] **Step 10: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/mobile -- src/features/owner/api.test.ts`
Expected: FAIL。`Cannot find module './api'`。

- [ ] **Step 11: API 関数を実装する**

```ts
// apps/mobile/src/features/owner/api.ts
import { API_BASE_URL, API_TIMEOUT_MS } from '@/constants/api';
import type { ZodType } from 'zod';

import {
  campaignListSchema,
  campaignSchema,
  menuItemSchema,
  menuTreeSchema,
  ownedShopSchema,
  ownerReviewListSchema,
  shopApplicationResponseSchema,
  shopHoursSchema,
  shopPhotoListSchema,
  shopPhotoSchema,
  shopSeatsSchema,
  shopStatsSchema,
} from './types';
import type {
  Campaign,
  MenuItem,
  MenuTree,
  OwnedShop,
  ShopApplication,
  ShopHours,
  ShopPhoto,
  ShopSeats,
  ShopStats,
} from './types';
import { z } from 'zod';

/** ステータスを保ったまま投げる。画面側は status で「権限が無い」「消えている」を出し分ける */
export class OwnerApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'OwnerApiError';
    this.status = status;
  }
}

/** エラー応答の形。errorHandler が返す { error: { status, message } } に対応する */
const errorBodySchema = z.object({ error: z.object({ message: z.string() }) });

const FALLBACK_ERROR_MESSAGE = '通信に失敗しました';

function buildUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

/** パスに差し込む ID は必ずここを通す。生で埋めるとスラッシュを持ち込まれて別のルートに当たる */
function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

async function readErrorMessage(response: Response): Promise<string> {
  // HTML のエラーページや空ボディが返ることがあるので、JSON でない場合も固定文言で通す
  const parsed = errorBodySchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.error.message : FALLBACK_ERROR_MESSAGE;
}

async function request<TValue>(
  path: string,
  schema: ZodType<TValue>,
  init?: RequestInit,
): Promise<TValue> {
  const response = await fetch(buildUrl(path), {
    ...init,
    credentials: 'include',
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new OwnerApiError(response.status, await readErrorMessage(response));
  }
  return schema.parse(await response.json());
}

/** 204 を返すエンドポイント用。本文を読まない */
async function requestNoContent(path: string, init: RequestInit): Promise<void> {
  const response = await fetch(buildUrl(path), {
    ...init,
    credentials: 'include',
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new OwnerApiError(response.status, await readErrorMessage(response));
  }
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// ── 店舗 ──

export async function fetchOwnedShops(): Promise<readonly OwnedShop[]> {
  const body = await request('/owner/shops', z.object({ shops: z.array(ownedShopSchema) }));
  return body.shops;
}

export function fetchShopStats(shopId: string, days: number): Promise<ShopStats> {
  return request(`/owner/shops/${encodeSegment(shopId)}/stats?days=${days}`, shopStatsSchema);
}

export function fetchShopHours(shopId: string): Promise<ShopHours> {
  return request(`/owner/shops/${encodeSegment(shopId)}/hours`, shopHoursSchema);
}

export function saveShopHours(shopId: string, hours: ShopHours['hours']): Promise<ShopHours> {
  return request(
    `/owner/shops/${encodeSegment(shopId)}/hours`,
    shopHoursSchema,
    jsonInit('PUT', { hours }),
  );
}

export function createClosure(
  shopId: string,
  closedOn: string,
  reason: string | null,
): Promise<ShopHours> {
  return request(
    `/owner/shops/${encodeSegment(shopId)}/closures`,
    shopHoursSchema,
    jsonInit('POST', { closedOn, reason }),
  );
}

export function deleteClosure(shopId: string, closureId: string): Promise<void> {
  return requestNoContent(
    `/owner/shops/${encodeSegment(shopId)}/closures/${encodeSegment(closureId)}`,
    {
      method: 'DELETE',
    },
  );
}

export function fetchShopSeats(shopId: string): Promise<ShopSeats> {
  return request(`/owner/shops/${encodeSegment(shopId)}/seats`, shopSeatsSchema);
}

export function saveShopSeats(shopId: string, seats: ShopSeats): Promise<ShopSeats> {
  return request(
    `/owner/shops/${encodeSegment(shopId)}/seats`,
    shopSeatsSchema,
    jsonInit('PUT', seats),
  );
}

// ── 写真 ──

/** expo-image-picker の ImagePickerAsset から必要な 3 つだけを受け取る（画面とこの層を疎にする） */
export interface PhotoUploadSource {
  readonly uri: string;
  readonly mimeType: string | undefined;
  readonly fileName: string | null | undefined;
}

const PHOTO_FIELD_NAME = 'file';
const FALLBACK_PHOTO_MIME = 'image/jpeg';
const FALLBACK_PHOTO_NAME = 'photo.jpg';

export async function fetchShopPhotos(shopId: string): Promise<readonly ShopPhoto[]> {
  const body = await request(`/owner/shops/${encodeSegment(shopId)}/photos`, shopPhotoListSchema);
  return body.photos;
}

export function uploadShopPhoto(shopId: string, source: PhotoUploadSource): Promise<ShopPhoto> {
  const form = new FormData();
  // React Native の FormData は { uri, type, name } を受け取る。Blob は端末上のファイルに使えない
  const filePart = {
    uri: source.uri,
    type: source.mimeType ?? FALLBACK_PHOTO_MIME,
    name: source.fileName ?? FALLBACK_PHOTO_NAME,
  };
  form.append(PHOTO_FIELD_NAME, filePart as unknown as Blob);
  // content-type は付けない。boundary を含む値はランタイムが組み立てる
  return request(`/owner/shops/${encodeSegment(shopId)}/photos`, shopPhotoSchema, {
    method: 'POST',
    body: form,
  });
}

export function updateShopPhoto(
  shopId: string,
  photoId: string,
  input: { caption: string | null; isCover: boolean },
): Promise<ShopPhoto> {
  return request(
    `/owner/shops/${encodeSegment(shopId)}/photos/${encodeSegment(photoId)}`,
    shopPhotoSchema,
    jsonInit('PATCH', input),
  );
}

export async function reorderShopPhotos(
  shopId: string,
  photoIds: readonly string[],
): Promise<readonly ShopPhoto[]> {
  const body = await request(
    `/owner/shops/${encodeSegment(shopId)}/photo-order`,
    shopPhotoListSchema,
    jsonInit('PUT', { photoIds }),
  );
  return body.photos;
}

export function deleteShopPhoto(shopId: string, photoId: string): Promise<void> {
  return requestNoContent(
    `/owner/shops/${encodeSegment(shopId)}/photos/${encodeSegment(photoId)}`,
    {
      method: 'DELETE',
    },
  );
}

// ── メニュー ──

export function fetchMenuTree(shopId: string): Promise<MenuTree> {
  return request(`/owner/shops/${encodeSegment(shopId)}/menu`, menuTreeSchema);
}

export function createMenuCategory(
  shopId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  return request(
    `/owner/shops/${encodeSegment(shopId)}/menu/categories`,
    z.object({ id: z.string(), name: z.string() }),
    jsonInit('POST', { name }),
  );
}

export function deleteMenuCategory(shopId: string, categoryId: string): Promise<void> {
  return requestNoContent(
    `/owner/shops/${encodeSegment(shopId)}/menu/categories/${encodeSegment(categoryId)}`,
    {
      method: 'DELETE',
    },
  );
}

// メニュー項目の入力型は @meshimap/core の menuItemInputSchema が唯一の定義元。
// ここで Omit<MenuItem, 'id'> を書くと、サーバが受け付ける形とクライアントが送る形が
// 別々に育ってしまう（core 側には sortOrder があり、レスポンスには無い）。
export type { MenuItemInput } from '@meshimap/core';

export function createMenuItem(shopId: string, input: MenuItemInput): Promise<MenuItem> {
  return request(
    `/owner/shops/${encodeSegment(shopId)}/menu/items`,
    menuItemSchema,
    jsonInit('POST', input),
  );
}

export function updateMenuItem(
  shopId: string,
  menuItemId: string,
  input: MenuItemInput,
): Promise<MenuItem> {
  return request(
    `/owner/shops/${encodeSegment(shopId)}/menu/items/${encodeSegment(menuItemId)}`,
    menuItemSchema,
    jsonInit('PATCH', input),
  );
}

export function deleteMenuItem(shopId: string, menuItemId: string): Promise<void> {
  return requestNoContent(
    `/owner/shops/${encodeSegment(shopId)}/menu/items/${encodeSegment(menuItemId)}`,
    {
      method: 'DELETE',
    },
  );
}

// ── レビュー ──

export async function fetchOwnerReviews(shopId: string): Promise<readonly OwnerReview[]> {
  const body = await request(
    `/owner/shops/${encodeSegment(shopId)}/reviews`,
    ownerReviewListSchema,
  );
  return body.reviews;
}

export function saveReviewReply(
  reviewId: string,
  body: string,
): Promise<{ body: string; updatedAt: string }> {
  return request(
    `/owner/reviews/${encodeSegment(reviewId)}/reply`,
    z.object({ body: z.string(), updatedAt: z.string() }),
    jsonInit('PUT', { body }),
  );
}

export function deleteReviewReply(reviewId: string): Promise<void> {
  return requestNoContent(`/owner/reviews/${encodeSegment(reviewId)}/reply`, { method: 'DELETE' });
}

export function reportReview(
  reviewId: string,
  reason: string,
  detail: string | null,
): Promise<void> {
  return requestNoContent(
    `/owner/reviews/${encodeSegment(reviewId)}/report`,
    jsonInit('POST', { reason, detail }),
  );
}

// ── クーポン ──

// クーポンの入力型も @meshimap/core の campaignInputSchema が唯一の定義元。
// 期間の前後関係や gift の値 0 固定といった refine を、画面側でも同じスキーマで効かせる。
export type { CampaignInput } from '@meshimap/core';

export async function fetchCampaigns(shopId: string): Promise<readonly Campaign[]> {
  const body = await request(`/owner/shops/${encodeSegment(shopId)}/campaigns`, campaignListSchema);
  return body.campaigns;
}

export function createCampaign(shopId: string, input: CampaignInput): Promise<Campaign> {
  return request(
    `/owner/shops/${encodeSegment(shopId)}/campaigns`,
    campaignSchema,
    jsonInit('POST', input),
  );
}

export function updateCampaign(campaignId: string, input: CampaignInput): Promise<Campaign> {
  return request(
    `/owner/campaigns/${encodeSegment(campaignId)}`,
    campaignSchema,
    jsonInit('PATCH', input),
  );
}

export function deleteCampaign(campaignId: string): Promise<void> {
  return requestNoContent(`/owner/campaigns/${encodeSegment(campaignId)}`, { method: 'DELETE' });
}

// ── 申請 ──

export async function fetchApplication(): Promise<ShopApplication | null> {
  const body = await request('/owner/application', shopApplicationResponseSchema);
  return body.application;
}

const DOCUMENT_FIELD_NAME = 'file';
const DOCUMENT_KIND_FIELD_NAME = 'kind';
const FALLBACK_DOCUMENT_MIME = 'application/pdf';
const FALLBACK_DOCUMENT_NAME = 'document.pdf';

export async function uploadApplicationDocument(
  kind: string,
  source: PhotoUploadSource,
): Promise<ShopApplication> {
  const form = new FormData();
  const filePart = {
    uri: source.uri,
    type: source.mimeType ?? FALLBACK_DOCUMENT_MIME,
    name: source.fileName ?? FALLBACK_DOCUMENT_NAME,
  };
  form.append(DOCUMENT_FIELD_NAME, filePart as unknown as Blob);
  form.append(DOCUMENT_KIND_FIELD_NAME, kind);
  const body = await request('/owner/application/documents', shopApplicationResponseSchema, {
    method: 'POST',
    body: form,
  });
  // documents 追加後の応答は必ず application を含む契約。null なら形が変わっている
  if (body.application === null) {
    throw new OwnerApiError(HTTP_STATUS_UNEXPECTED, FALLBACK_ERROR_MESSAGE);
  }
  return body.application;
}

export async function resubmitApplication(note: string): Promise<ShopApplication> {
  const body = await request(
    '/owner/application/resubmit',
    shopApplicationResponseSchema,
    jsonInit('POST', { note }),
  );
  if (body.application === null) {
    throw new OwnerApiError(HTTP_STATUS_UNEXPECTED, FALLBACK_ERROR_MESSAGE);
  }
  return body.application;
}
```

`HTTP_STATUS_UNEXPECTED` は `src/constants/http.ts` に足す。**既存の `HTTP_STATUS` は `unauthorized` / `forbidden` / `conflict` / `tooManyRequests` の 4 キーしか無い（実ファイルで確認済み）ので、Phase 8 で `notFound: 404` と `unexpected: 520` を追加する。** 520 は「サーバが契約外の応答を返した」を表す非標準コードで、Cloudflare が同じ意味で使っている。

```ts
// apps/mobile/src/constants/http.ts に追記
export const HTTP_STATUS = {
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  tooManyRequests: 429,
  /** サーバが契約どおりの形を返さなかったときに、クライアント側が名乗らせる値 */
  unexpected: 520,
} as const;
```

`api.ts` の冒頭で `import { HTTP_STATUS } from '@/constants/http';` し、`HTTP_STATUS_UNEXPECTED` は `HTTP_STATUS.unexpected` に置き換える。**上のコード片で仮の名前を使ったのは読みやすさのためで、実装では定数オブジェクト経由にする。**

- [ ] **Step 12: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/mobile -- src/features/owner/api.test.ts src/constants/http.test.ts`
Expected: PASS。`http.test.ts` は既存の期待値（4 キー）を 6 キーに更新する必要があるので、落ちたらキー一覧を直す。

- [ ] **Step 13: Query フックの失敗するテストを書く**

```tsx
// apps/mobile/src/features/owner/testing/query-wrapper.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

export interface QueryWrapper {
  readonly wrapper: ({ children }: { children: ReactNode }) => ReactNode;
  readonly client: QueryClient;
}

/**
 * テスト用の QueryClient。
 * retry を切るのが要点で、既定の 3 回再試行のままだと「失敗するはずのテスト」が
 * タイムアウトするまで終わらない。
 */
export function createQueryWrapper(): QueryWrapper {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { wrapper, client };
}
```

```tsx
// apps/mobile/src/features/owner/queries.test.tsx
import { describe, expect, it, jest } from '@jest/globals';
import { renderHook, waitFor } from '@testing-library/react-native';

import { ownerQueryKeys, useOwnedShops, useSaveReviewReply, useShopStats } from './queries';
import { createQueryWrapper } from './testing/query-wrapper';

jest.mock('./api');
const mockedApi = jest.requireMock<typeof import('./api')>('./api');

describe('ownerQueryKeys', () => {
  it('店舗ごとに別のキーになる（片方の更新で他店のキャッシュを消さない）', () => {
    expect(ownerQueryKeys.stats('shp_1', 7)).not.toEqual(ownerQueryKeys.stats('shp_2', 7));
  });

  it('期間ごとに別のキーになる（7 日と 30 日が混ざらない）', () => {
    expect(ownerQueryKeys.stats('shp_1', 7)).not.toEqual(ownerQueryKeys.stats('shp_1', 30));
  });

  it('shop(shopId) は stats のキーの接頭辞になっている（店舗単位で一括無効化できる）', () => {
    const shopKey = ownerQueryKeys.shop('shp_1');
    expect(ownerQueryKeys.stats('shp_1', 7).slice(0, shopKey.length)).toEqual(shopKey);
  });
});

describe('useOwnedShops', () => {
  it('成功するとデータを返す', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([
      { id: 'shp_1', name: 'ラーメン太郎', status: 'published', ratingAvg: 4, ratingCount: 2 },
    ]);
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useOwnedShops(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.name).toBe('ラーメン太郎');
  });

  it('失敗すると isError になる（retry で待たされない）', async () => {
    mockedApi.fetchOwnedShops.mockRejectedValue(new Error('落ちた'));
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useOwnedShops(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useShopStats', () => {
  it('shopId が null のときは API を呼ばない', async () => {
    const { wrapper } = createQueryWrapper();
    renderHook(() => useShopStats(null, 7), { wrapper });
    await waitFor(() => expect(mockedApi.fetchShopStats).not.toHaveBeenCalled());
  });

  it('shopId があるときは days つきで呼ぶ', async () => {
    mockedApi.fetchShopStats.mockResolvedValue({
      days: 30,
      views: { points: [], total: 0, previousTotal: 0, changeRate: null },
      favorites: { points: [], total: 0, previousTotal: 0, changeRate: null },
      reservations: { points: [], total: 0, previousTotal: 0, changeRate: null },
      ratings: { points: [], total: 0, previousTotal: 0, changeRate: null },
    });
    const { wrapper } = createQueryWrapper();
    renderHook(() => useShopStats('shp_1', 30), { wrapper });
    await waitFor(() => expect(mockedApi.fetchShopStats).toHaveBeenCalledWith('shp_1', 30));
  });
});

describe('useSaveReviewReply', () => {
  it('成功するとレビュー一覧のキャッシュを無効化する', async () => {
    mockedApi.saveReviewReply.mockResolvedValue({
      body: '返信',
      updatedAt: '2026-09-15T00:00:00.000Z',
    });
    const { wrapper, client } = createQueryWrapper();
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useSaveReviewReply('shp_1'), { wrapper });
    result.current.mutate({ reviewId: 'rvw_1', body: '返信' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ownerQueryKeys.reviews('shp_1') });
  });

  it('失敗したときはキャッシュを無効化しない（画面の表示を巻き戻さない）', async () => {
    mockedApi.saveReviewReply.mockRejectedValue(new Error('落ちた'));
    const { wrapper, client } = createQueryWrapper();
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useSaveReviewReply('shp_1'), { wrapper });
    result.current.mutate({ reviewId: 'rvw_1', body: '返信' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 14: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/mobile -- src/features/owner/queries.test.tsx`
Expected: FAIL。`Cannot find module './queries'`。

- [ ] **Step 15: Query フックを実装する**

```ts
// apps/mobile/src/features/owner/queries.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

import {
  createCampaign,
  createClosure,
  createMenuCategory,
  createMenuItem,
  deleteCampaign,
  deleteClosure,
  deleteMenuCategory,
  deleteMenuItem,
  deleteReviewReply,
  deleteShopPhoto,
  fetchApplication,
  fetchCampaigns,
  fetchMenuTree,
  fetchOwnedShops,
  fetchOwnerReviews,
  fetchShopHours,
  fetchShopPhotos,
  fetchShopSeats,
  fetchShopStats,
  reorderShopPhotos,
  resubmitApplication,
  saveReviewReply,
  saveShopHours,
  saveShopSeats,
  updateCampaign,
  updateMenuItem,
  updateShopPhoto,
  uploadApplicationDocument,
  uploadShopPhoto,
} from './api';
import type { CampaignInput, MenuItemInput, PhotoUploadSource } from './api';
import type {
  Campaign,
  MenuTree,
  OwnedShop,
  OwnerReview,
  ShopApplication,
  ShopHours,
  ShopPhoto,
  ShopSeats,
  ShopStats,
} from './types';

const OWNER_KEY_ROOT = 'owner';

/**
 * クエリキーの唯一の定義元。
 * shop(shopId) をすべての店舗別キーの接頭辞にしてあるので、
 * invalidateQueries({ queryKey: ownerQueryKeys.shop(id) }) で店舗単位の一括無効化ができる。
 */
export const ownerQueryKeys = {
  shops: () => [OWNER_KEY_ROOT, 'shops'] as const,
  shop: (shopId: string) => [OWNER_KEY_ROOT, 'shop', shopId] as const,
  stats: (shopId: string, days: number) => [OWNER_KEY_ROOT, 'shop', shopId, 'stats', days] as const,
  hours: (shopId: string) => [OWNER_KEY_ROOT, 'shop', shopId, 'hours'] as const,
  seats: (shopId: string) => [OWNER_KEY_ROOT, 'shop', shopId, 'seats'] as const,
  photos: (shopId: string) => [OWNER_KEY_ROOT, 'shop', shopId, 'photos'] as const,
  menu: (shopId: string) => [OWNER_KEY_ROOT, 'shop', shopId, 'menu'] as const,
  reviews: (shopId: string) => [OWNER_KEY_ROOT, 'shop', shopId, 'reviews'] as const,
  campaigns: (shopId: string) => [OWNER_KEY_ROOT, 'shop', shopId, 'campaigns'] as const,
  application: () => [OWNER_KEY_ROOT, 'application'] as const,
} as const;

export function useOwnedShops(): UseQueryResult<readonly OwnedShop[], Error> {
  return useQuery({ queryKey: ownerQueryKeys.shops(), queryFn: fetchOwnedShops });
}

/**
 * shopId が null の間は enabled: false で API を呼ばない。
 * 店舗一覧の取得が終わるまで shopId が決まらないため、null を「まだ分からない」として扱う。
 */
export function useShopStats(
  shopId: string | null,
  days: number,
): UseQueryResult<ShopStats, Error> {
  return useQuery({
    queryKey: ownerQueryKeys.stats(shopId ?? '', days),
    queryFn: () => fetchShopStats(shopId ?? '', days),
    enabled: shopId !== null,
  });
}

export function useShopHours(shopId: string | null): UseQueryResult<ShopHours, Error> {
  return useQuery({
    queryKey: ownerQueryKeys.hours(shopId ?? ''),
    queryFn: () => fetchShopHours(shopId ?? ''),
    enabled: shopId !== null,
  });
}

export function useShopPhotos(shopId: string | null): UseQueryResult<readonly ShopPhoto[], Error> {
  return useQuery({
    queryKey: ownerQueryKeys.photos(shopId ?? ''),
    queryFn: () => fetchShopPhotos(shopId ?? ''),
    enabled: shopId !== null,
  });
}

export function useShopSeats(shopId: string | null): UseQueryResult<ShopSeats, Error> {
  return useQuery({
    queryKey: ownerQueryKeys.seats(shopId ?? ''),
    queryFn: () => fetchShopSeats(shopId ?? ''),
    enabled: shopId !== null,
  });
}

export function useMenuTree(shopId: string | null): UseQueryResult<MenuTree, Error> {
  return useQuery({
    queryKey: ownerQueryKeys.menu(shopId ?? ''),
    queryFn: () => fetchMenuTree(shopId ?? ''),
    enabled: shopId !== null,
  });
}

export function useOwnerReviews(
  shopId: string | null,
): UseQueryResult<readonly OwnerReview[], Error> {
  return useQuery({
    queryKey: ownerQueryKeys.reviews(shopId ?? ''),
    queryFn: () => fetchOwnerReviews(shopId ?? ''),
    enabled: shopId !== null,
  });
}

export function useCampaigns(shopId: string | null): UseQueryResult<readonly Campaign[], Error> {
  return useQuery({
    queryKey: ownerQueryKeys.campaigns(shopId ?? ''),
    queryFn: () => fetchCampaigns(shopId ?? ''),
    enabled: shopId !== null,
  });
}

export function useApplication(): UseQueryResult<ShopApplication | null, Error> {
  return useQuery({ queryKey: ownerQueryKeys.application(), queryFn: fetchApplication });
}

export interface ReviewReplyVariables {
  readonly reviewId: string;
  readonly body: string;
}

export function useSaveReviewReply(
  shopId: string,
): UseMutationResult<{ body: string; updatedAt: string }, Error, ReviewReplyVariables> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ reviewId, body }: ReviewReplyVariables) => saveReviewReply(reviewId, body),
    // onSuccess だけで無効化する。onSettled にすると失敗時にも走り、画面の入力が消える
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ownerQueryKeys.reviews(shopId) });
    },
  });
}
```

**残りのミューテーションフック（`useDeleteReviewReply` / `useSaveShopHours` / `useCreateClosure` / `useDeleteClosure` / `useSaveShopSeats` / `useUploadShopPhoto` / `useUpdateShopPhoto` / `useReorderShopPhotos` / `useDeleteShopPhoto` / `useCreateMenuCategory` / `useDeleteMenuCategory` / `useCreateMenuItem` / `useUpdateMenuItem` / `useDeleteMenuItem` / `useCreateCampaign` / `useUpdateCampaign` / `useDeleteCampaign` / `useUploadApplicationDocument` / `useResubmitApplication`）も同じ形で書く。** 形は 3 点セットで固定する。

1. `mutationFn` は `api.ts` の関数をそのまま呼ぶ（フック内でロジックを持たない）
2. `onSuccess` で対応するクエリキーだけを `invalidateQueries` する（`onSettled` は使わない）
3. 返り値の型を `UseMutationResult<結果, Error, 変数>` で明示する（`any` の混入を型で止める）

対応するクエリキーは次のとおり。

| フック                                                                                                              | 無効化するキー                     |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `useSaveShopHours` / `useCreateClosure` / `useDeleteClosure`                                                        | `ownerQueryKeys.hours(shopId)`     |
| `useSaveShopSeats`                                                                                                  | `ownerQueryKeys.seats(shopId)`     |
| `useUploadShopPhoto` / `useUpdateShopPhoto` / `useReorderShopPhotos` / `useDeleteShopPhoto`                         | `ownerQueryKeys.photos(shopId)`    |
| `useCreateMenuCategory` / `useDeleteMenuCategory` / `useCreateMenuItem` / `useUpdateMenuItem` / `useDeleteMenuItem` | `ownerQueryKeys.menu(shopId)`      |
| `useSaveReviewReply` / `useDeleteReviewReply`                                                                       | `ownerQueryKeys.reviews(shopId)`   |
| `useCreateCampaign` / `useUpdateCampaign` / `useDeleteCampaign`                                                     | `ownerQueryKeys.campaigns(shopId)` |
| `useUploadApplicationDocument` / `useResubmitApplication`                                                           | `ownerQueryKeys.application()`     |

**「同じ形で書く」で迷わないよう、変数の型が自明でない 5 本だけシグネチャを先に決めておく。** 残りは第 3 引数が `string`（対象の ID）か、`api.ts` の第 2 引数の型そのままである。

```ts
export function useCreateCampaign(
  shopId: string,
): UseMutationResult<Campaign, Error, CampaignInput>;
export function useUpdateCampaign(
  shopId: string,
): UseMutationResult<
  Campaign,
  Error,
  { readonly campaignId: string; readonly input: CampaignInput }
>;
export function useDeleteCampaign(shopId: string): UseMutationResult<void, Error, string>;
export function useUploadApplicationDocument(): UseMutationResult<
  ShopApplication,
  Error,
  { readonly kind: DocumentKind; readonly source: PhotoUploadSource }
>;
export function useResubmitApplication(): UseMutationResult<ShopApplication, Error, string>;
```

**`DocumentKind` は Task 8-22 で `constants/owner.ts` に定義する。** Task 8-15 の時点では `api.ts` の `uploadApplicationDocument` の第 1 引数を `string` のままにしておき、Task 8-22 で `DocumentKind` に狭める（その時点で選択肢の一覧が決まるため）。

**各フックに「成功時に正しいキーを無効化する」「失敗時は無効化しない」の 2 テストを必ず書く。** キーの取り違えは型では検出できず、画面では「保存したのに古い値が出る」という再現しにくい症状になる。

- [ ] **Step 16: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/mobile -- src/features/owner/queries.test.tsx`
Expected: PASS。

- [ ] **Step 17: わざと壊して検証が効いていることを確認する**

`queries.ts` の `useShopStats` から `enabled: shopId !== null` を消す。
Expected: FAIL。「shopId が null のときは API を呼ばない」が落ちる（`fetchShopStats` が `''` で呼ばれる）。

次に `useSaveReviewReply` の `onSuccess` を `onSettled` に変える。
Expected: FAIL。「失敗したときはキャッシュを無効化しない」が落ちる。

次に `ownerQueryKeys.stats` から `days` を外す。
Expected: FAIL。「期間ごとに別のキーになる」が落ちる。

次に `api.ts` の `encodeSegment` を `(value) => value` に変える。
Expected: FAIL。「店舗 ID を URL エンコードする」が落ちる。

**4 つとも確認したら元に戻し、再度テストが緑になることを確認する。**

- [ ] **Step 18: カバレッジと型・lint を通す**

Run: `npm run test -w @meshimap/mobile -- --coverage --collectCoverageFrom='src/features/owner/**' --collectCoverageFrom='src/constants/owner.ts' && npm run typecheck -w @meshimap/mobile && npm run lint`
Expected: カバレッジ 100%（statements / branches / functions / lines）。届かない場合、未到達の分岐は `?? ''` のフォールバックか `catch` 節のはずなので、**到達できるテストを足して埋める。`collectCoverageFrom` から外して逃げてはならない。**

- [ ] **Step 19: コミット**

```bash
git add apps/mobile/src/features/owner apps/mobile/src/constants/owner.ts apps/mobile/src/constants/owner.test.ts apps/mobile/src/constants/http.ts apps/mobile/src/constants/http.test.ts
git commit -m "feat(mobile): 店舗管理者向けの API クライアントと Query フックを追加"
```

---

## Task 8-16: 折れ線グラフ部品と KPI カード

**Files:**

- Create: `apps/mobile/src/components/chart/build-line-path.ts`
- Create: `apps/mobile/src/components/chart/build-line-path.test.ts`
- Create: `apps/mobile/src/components/chart/line-chart.tsx`
- Create: `apps/mobile/src/components/chart/line-chart.test.tsx`
- Create: `apps/mobile/src/components/owner/kpi-card.tsx`
- Create: `apps/mobile/src/components/owner/kpi-card.test.tsx`

**Interfaces:**

- Consumes: `DailyPoint` / `MetricSeries`（Task 8-15 の `features/owner/types.ts`）、`Card`（`components/ui/card.tsx`、`CardProps = { children; onPress?; padding?; testID? }`）、`Badge`（`BadgeProps = { label; tone?; leadingIcon?; testID? }`、`BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'brand'`）、`Icon`（`IconProps = { icon: LucideIcon; size?; color?; testID? }`）、`react-native-svg` 15.15.4 の `Svg` / `Path` / `Line`
- Produces:
  - `buildLinePath(values: readonly number[], size: ChartSize): string`
  - `ChartSize = { readonly width: number; readonly height: number }`
  - `averageOfPoints(points: readonly DailyPoint[]): number`
  - `LineChart({ values, width, height, testID }: LineChartProps)`
  - `KpiCard({ label, series, format, testID }: KpiCardProps)` / `KpiFormat = 'count' | 'rating'`

### なぜ描画とパス計算を 2 ファイルに割るのか

`buildLinePath` は数値配列を SVG の `d` 属性文字列に変える純関数で、React も RN も要らない。分けておけば、**「点が 1 個」「全部同じ値」「全部 0」「負の値」といった意地悪な入力を、レンダリングを経由せずに直接テストできる。** Stryker 相当の変異（`-` を `+` に変える、`0` を `1` にする）も、純関数なら文字列の差として確実に落ちる。

`line-chart.tsx` 側に残るのは「`Svg` に幅・高さを渡し、`Path` に `d` を渡す」だけになる。RNTL のレンダリングテストで検証する項目が少なくなるので、100% カバレッジを取りやすい。

### KPI の「平均評価」だけ扱いが違う

`MetricSeries.total` は日次値の合計である。閲覧数・お気に入り・予約はそれで正しいが、**評価は「合計」に意味が無い**（4.2 + 4.5 = 8.7 は何も表さない）。Task 8-11 のリポジトリも「`ratings.total` は意味を持たない」と注記している。

そこで `KpiCard` は `format` を受け取り、`'rating'` のときだけ `averageOfPoints(series.points)` を表示する。前期間比も評価では出さない（合計比になってしまうため）。**この分岐は `format` の 2 値で完結し、データの中身では分岐しない。**

- [ ] **Step 1: `buildLinePath` の失敗するテストを書く**

```ts
// apps/mobile/src/components/chart/build-line-path.test.ts
import { describe, expect, it } from '@jest/globals';

import { averageOfPoints, buildLinePath } from './build-line-path';

const size = { width: 100, height: 50 };

describe('buildLinePath', () => {
  it('点が 0 個なら空文字を返す（Path に渡しても何も描かれない）', () => {
    expect(buildLinePath([], size)).toBe('');
  });

  it('点が 1 個なら左端に置き、縦は中央にする（最大と最小が同じなので上下を決められない）', () => {
    expect(buildLinePath([7], size)).toBe('M0,25');
  });

  it('2 点なら M と L をつないだパスになる', () => {
    expect(buildLinePath([0, 10], size)).toBe('M0,50 L100,0');
  });

  it('最大値が上端（y=0）、最小値が下端（y=height）に来る', () => {
    const path = buildLinePath([5, 1, 9], size);
    expect(path).toContain(',0');
    expect(path).toContain(',50');
  });

  it('全部同じ値なら全点が中央の高さに並ぶ（0 除算しない）', () => {
    expect(buildLinePath([3, 3, 3], size)).toBe('M0,25 L50,25 L100,25');
  });

  it('全部 0 でも中央の高さに並ぶ（閲覧記録がまだ動いていない状態）', () => {
    expect(buildLinePath([0, 0, 0], size)).toBe('M0,25 L50,25 L100,25');
  });

  it('負の値があっても最小値が下端になる', () => {
    expect(buildLinePath([-10, 10], size)).toBe('M0,50 L100,0');
  });

  it('x 座標は等間隔になる（4 点なら 0 / 33.33 / 66.67 / 100）', () => {
    const path = buildLinePath([0, 1, 2, 3], { width: 90, height: 10 });
    expect(path.split(' ').map((command) => command.replace(/^[ML]/, '').split(',')[0])).toEqual([
      '0',
      '30',
      '60',
      '90',
    ]);
  });

  it('座標は小数第 2 位までに丸める（d 属性が無駄に長くならない）', () => {
    expect(buildLinePath([0, 1, 2], { width: 100, height: 3 })).toBe('M0,3 L50,1.5 L100,0');
  });
});

describe('averageOfPoints', () => {
  it('点が無ければ 0 を返す', () => {
    expect(averageOfPoints([])).toBe(0);
  });

  it('値の平均を返す', () => {
    expect(
      averageOfPoints([
        { date: '2026-09-14', value: 4 },
        { date: '2026-09-15', value: 5 },
      ]),
    ).toBe(4.5);
  });

  it('値が 0 の日も母数に数える（評価が付かなかった日を除外しない）', () => {
    expect(
      averageOfPoints([
        { date: '2026-09-14', value: 0 },
        { date: '2026-09-15', value: 4 },
      ]),
    ).toBe(2);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/mobile -- src/components/chart/build-line-path.test.ts`
Expected: FAIL。`Cannot find module './build-line-path'`。

- [ ] **Step 3: `buildLinePath` を実装する**

```ts
// apps/mobile/src/components/chart/build-line-path.ts
import type { DailyPoint } from '@/features/owner/types';

export interface ChartSize {
  readonly width: number;
  readonly height: number;
}

/** 座標の小数桁。SVG の d 属性は文字列なので、丸めないと 1 点あたり 30 文字を超えることがある */
const COORDINATE_FRACTION_DIGITS = 2;

/** 値の幅が 0（全点同じ）のときに置く縦位置の比率。上下どちらにも寄せる理由が無いので中央 */
const FLAT_LINE_RATIO = 0.5;

/** 末尾の 0 を落として文字列化する。25.00 ではなく 25 にする */
function formatCoordinate(value: number): string {
  return Number(value.toFixed(COORDINATE_FRACTION_DIGITS)).toString();
}

/**
 * 値の配列を SVG の d 属性に変える。
 *
 * SVG の y 軸は下向きなので、値が大きいほど y は小さくなる。
 * 最大値と最小値が等しいときは値の幅が 0 になり、そのまま比を取ると 0 除算になるため
 * 中央の高さに固定する（折れ線としては水平な直線になる）。
 */
export function buildLinePath(values: readonly number[], size: ChartSize): string {
  if (values.length === 0) {
    return '';
  }

  const maxValue = Math.max(...values);
  const minValue = Math.min(...values);
  const valueRange = maxValue - minValue;
  // 点が 1 個のときも分母が 0 になるので、x は左端に固定する
  const xStep = values.length === 1 ? 0 : size.width / (values.length - 1);

  const commands = values.map((value, index) => {
    const x = xStep * index;
    const ratio = valueRange === 0 ? FLAT_LINE_RATIO : (maxValue - value) / valueRange;
    const y = size.height * ratio;
    const prefix = index === 0 ? 'M' : 'L';
    return `${prefix}${formatCoordinate(x)},${formatCoordinate(y)}`;
  });

  return commands.join(' ');
}

/**
 * 日次の点の平均。
 * 平均評価の KPI で使う。合計では意味を成さない指標がここを通る。
 */
export function averageOfPoints(points: readonly DailyPoint[]): number {
  if (points.length === 0) {
    return 0;
  }
  const sum = points.reduce((total, point) => total + point.value, 0);
  return sum / points.length;
}
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/mobile -- src/components/chart/build-line-path.test.ts`
Expected: PASS（12 件）。

- [ ] **Step 5: `LineChart` の失敗するテストを書く**

```tsx
// apps/mobile/src/components/chart/line-chart.test.tsx
import { describe, expect, it } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';

import { LineChart } from './line-chart';

describe('LineChart', () => {
  it('値があれば折れ線が描かれる', () => {
    render(<LineChart values={[1, 2, 3]} width={100} height={50} testID="chart" />);
    expect(screen.getByTestId('chart-line', { includeHiddenElements: true })).toBeTruthy();
  });

  it('値が空なら折れ線を描かず、代わりに「データがありません」を出す', () => {
    render(<LineChart values={[]} width={100} height={50} testID="chart" />);
    expect(screen.queryByTestId('chart-line', { includeHiddenElements: true })).toBeNull();
    expect(screen.getByText('データがありません')).toBeTruthy();
  });

  it('全点 0 でも折れ線は描かれる（データが無いのとは別の状態）', () => {
    render(<LineChart values={[0, 0, 0]} width={100} height={50} testID="chart" />);
    expect(screen.getByTestId('chart-line', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByText('データがありません')).toBeNull();
  });

  it('testID が無ければ子要素にも testID を付けない', () => {
    render(<LineChart values={[1, 2]} width={100} height={50} />);
    expect(screen.queryByTestId('undefined-line', { includeHiddenElements: true })).toBeNull();
  });

  it('グラフ全体に読み上げ用のラベルが付く（線は目で見るものなので文言で補う）', () => {
    render(<LineChart values={[1, 2, 3]} width={100} height={50} testID="chart" />);
    expect(screen.getByLabelText('推移グラフ。3 日分、最小 1、最大 3')).toBeTruthy();
  });
});
```

- [ ] **Step 6: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/mobile -- src/components/chart/line-chart.test.tsx`
Expected: FAIL。`Cannot find module './line-chart'`。

- [ ] **Step 7: `LineChart` を実装する**

```tsx
// apps/mobile/src/components/chart/line-chart.tsx
import { Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { COLORS } from '@/constants/theme';

import { buildLinePath } from './build-line-path';

export interface LineChartProps {
  values: readonly number[];
  width: number;
  height: number;
  testID?: string | undefined;
}

/** 折れ線の色。ブランド色にしてダッシュボードの主役であることを示す */
const LINE_COLOR = COLORS.primary[500];

/** 線の太さ（px）。細すぎると端末によっては消える */
const LINE_STROKE_WIDTH = 2;

const EMPTY_MESSAGE = 'データがありません';

const LINE_TEST_ID_SUFFIX = 'line';

/** 親が testID を持たないときは子にも付けない（ErrorState と同じ規約） */
function buildChildTestId(testID: string | undefined, suffix: string): string | undefined {
  return testID === undefined ? undefined : `${testID}-${suffix}`;
}

/** 線そのものは読み上げられないので、件数と範囲を文言にして渡す */
function buildAccessibilityLabel(values: readonly number[]): string {
  return `推移グラフ。${values.length} 日分、最小 ${Math.min(...values)}、最大 ${Math.max(...values)}`;
}

export function LineChart({ values, width, height, testID }: LineChartProps) {
  if (values.length === 0) {
    return (
      <View className="items-center justify-center" style={{ width, height }} testID={testID}>
        <Text className="text-sm text-neutral-500">{EMPTY_MESSAGE}</Text>
      </View>
    );
  }

  return (
    <View accessible accessibilityLabel={buildAccessibilityLabel(values)} testID={testID}>
      <Svg width={width} height={height}>
        <Path
          d={buildLinePath(values, { width, height })}
          stroke={LINE_COLOR}
          strokeWidth={LINE_STROKE_WIDTH}
          fill="none"
          testID={buildChildTestId(testID, LINE_TEST_ID_SUFFIX)}
        />
      </Svg>
    </View>
  );
}
```

**`react-native-svg` は `jest-expo` のプリセットで動く（RN コンポーネントとして描画され、`testID` はそのまま伝わる）。もし `Svg` の描画で落ちるなら、`jest.config.js` の `transformIgnorePatterns` に `react-native-svg` が含まれているかを確認する。未確認：このリポジトリで `react-native-svg` を実際に描画した実績はまだ無い。**

- [ ] **Step 8: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/mobile -- src/components/chart/line-chart.test.tsx`
Expected: PASS（5 件）。

- [ ] **Step 9: `KpiCard` の失敗するテストを書く**

```tsx
// apps/mobile/src/components/owner/kpi-card.test.tsx
import { describe, expect, it } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';

import { KpiCard } from './kpi-card';

const series = (points: readonly number[], previousTotal: number, changeRate: number | null) => ({
  points: points.map((value, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, '0')}`,
    value,
  })),
  total: points.reduce((sum, value) => sum + value, 0),
  previousTotal,
  changeRate,
});

describe('KpiCard（format="count"）', () => {
  it('合計値を表示する', () => {
    render(<KpiCard label="閲覧数" series={series([1, 2, 3], 3, 1)} format="count" testID="kpi" />);
    expect(screen.getByText('6')).toBeTruthy();
  });

  it('増加なら +100% を success 色のバッジで出す', () => {
    render(<KpiCard label="閲覧数" series={series([1, 2, 3], 3, 1)} format="count" testID="kpi" />);
    expect(screen.getByText('+100%')).toBeTruthy();
  });

  it('減少なら -50% を出す', () => {
    render(<KpiCard label="閲覧数" series={series([1], 2, -0.5)} format="count" testID="kpi" />);
    expect(screen.getByText('-50%')).toBeTruthy();
  });

  it('増減なしなら ±0% を出す', () => {
    render(<KpiCard label="閲覧数" series={series([2], 2, 0)} format="count" testID="kpi" />);
    expect(screen.getByText('±0%')).toBeTruthy();
  });

  it('changeRate が null なら「前期間との比較なし」を出す（0% とは書かない）', () => {
    render(<KpiCard label="閲覧数" series={series([3], 0, null)} format="count" testID="kpi" />);
    expect(screen.getByText('前期間との比較なし')).toBeTruthy();
    expect(screen.queryByText('±0%')).toBeNull();
  });

  it('全日 0 でも 0 と表示して落ちない', () => {
    render(
      <KpiCard label="閲覧数" series={series([0, 0, 0], 0, null)} format="count" testID="kpi" />,
    );
    expect(screen.getByText('0')).toBeTruthy();
  });
});

describe('KpiCard（format="rating"）', () => {
  it('合計ではなく平均を小数第 1 位で表示する', () => {
    render(
      <KpiCard label="平均評価" series={series([4, 5], 0, null)} format="rating" testID="kpi" />,
    );
    expect(screen.getByText('4.5')).toBeTruthy();
    expect(screen.queryByText('9')).toBeNull();
  });

  it('評価では前期間比を出さない（合計比になってしまうため）', () => {
    render(<KpiCard label="平均評価" series={series([4, 5], 3, 2)} format="rating" testID="kpi" />);
    expect(screen.queryByText('+200%')).toBeNull();
    expect(screen.queryByText('前期間との比較なし')).toBeNull();
  });

  it('点が 0 個なら 0.0 と表示する', () => {
    render(<KpiCard label="平均評価" series={series([], 0, null)} format="rating" testID="kpi" />);
    expect(screen.getByText('0.0')).toBeTruthy();
  });
});
```

- [ ] **Step 10: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/mobile -- src/components/owner/kpi-card.test.tsx`
Expected: FAIL。`Cannot find module './kpi-card'`。

- [ ] **Step 11: `KpiCard` を実装する**

```tsx
// apps/mobile/src/components/owner/kpi-card.tsx
import { Text, View } from 'react-native';

import { LineChart } from '@/components/chart/line-chart';
import { averageOfPoints } from '@/components/chart/build-line-path';
import { Badge } from '@/components/ui/badge';
import type { BadgeTone } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { MetricSeries } from '@/features/owner/types';

export type KpiFormat = 'count' | 'rating';

export interface KpiCardProps {
  label: string;
  series: MetricSeries;
  format: KpiFormat;
  testID?: string | undefined;
}

/** カード内のスパークラインの寸法（px）。2 列グリッドの片側に収まる幅にする */
const SPARKLINE_WIDTH = 120;
const SPARKLINE_HEIGHT = 32;

/** 評価の表示桁。4.5 のように小数第 1 位まで見せる */
const RATING_FRACTION_DIGITS = 1;

/** 前期間が 0 で比較できないときの文言。「±0%」と書くと「変化が無かった」と誤読される */
const NO_COMPARISON_LABEL = '前期間との比較なし';

/** 増減なしの記号。+0% でも -0% でもないことを示す */
const FLAT_CHANGE_LABEL = '±0%';

const PERCENT_MULTIPLIER = 100;

function formatChangeRate(changeRate: number): string {
  const percent = Math.round(changeRate * PERCENT_MULTIPLIER);
  if (percent === 0) {
    return FLAT_CHANGE_LABEL;
  }
  return percent > 0 ? `+${percent}%` : `${percent}%`;
}

function toChangeTone(changeRate: number): BadgeTone {
  if (changeRate > 0) {
    return 'success';
  }
  return changeRate < 0 ? 'danger' : 'neutral';
}

export function KpiCard({ label, series, format, testID }: KpiCardProps) {
  const isRating = format === 'rating';
  const value = isRating
    ? averageOfPoints(series.points).toFixed(RATING_FRACTION_DIGITS)
    : String(series.total);

  return (
    <Card padding="sm" testID={testID}>
      <Text className="text-sm text-neutral-600">{label}</Text>
      <Text className="mt-1 text-2xl font-bold text-neutral-900">{value}</Text>
      {/* 評価は合計に意味が無いため、前期間比も出さない */}
      {!isRating &&
        (series.changeRate === null ? (
          <Text className="mt-1 text-xs text-neutral-500">{NO_COMPARISON_LABEL}</Text>
        ) : (
          <View className="mt-1 flex-row">
            <Badge
              label={formatChangeRate(series.changeRate)}
              tone={toChangeTone(series.changeRate)}
            />
          </View>
        ))}
      <View className="mt-2">
        <LineChart
          values={series.points.map((point) => point.value)}
          width={SPARKLINE_WIDTH}
          height={SPARKLINE_HEIGHT}
        />
      </View>
    </Card>
  );
}
```

- [ ] **Step 12: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/mobile -- src/components/owner/kpi-card.test.tsx`
Expected: PASS（9 件）。

- [ ] **Step 13: わざと壊して検証が効いていることを確認する**

`build-line-path.ts` の `valueRange === 0 ? FLAT_LINE_RATIO : ...` を `(maxValue - value) / valueRange` だけにする（0 除算を戻す）。
Expected: FAIL。「全部同じ値なら〜」「全部 0 でも〜」の 2 件が `NaN` を含むパスになって落ちる。

次に `kpi-card.tsx` の `series.changeRate === null` の分岐を消し、常にバッジを出すようにする。
Expected: FAIL。「changeRate が null なら「前期間との比較なし」を出す」が落ちる。

次に `kpi-card.tsx` の `isRating` 判定を `format === 'count'` に反転させる。
Expected: FAIL。`format="rating"` の 3 件と `format="count"` の合計表示が落ちる。

次に `build-line-path.ts` の `averageOfPoints` の `points.length === 0` ガードを消す。
Expected: FAIL。「点が無ければ 0 を返す」が `NaN` で落ち、`KpiCard` の「点が 0 個なら 0.0」も落ちる。

**4 つとも確認したら元に戻す。**

- [ ] **Step 14: カバレッジ・型・lint を通してコミット**

Run: `npm run test -w @meshimap/mobile -- --coverage --collectCoverageFrom='src/components/chart/**' --collectCoverageFrom='src/components/owner/kpi-card.tsx' && npm run typecheck -w @meshimap/mobile && npm run lint`
Expected: カバレッジ 100%、型・lint とも成功。

```bash
git add apps/mobile/src/components/chart apps/mobile/src/components/owner
git commit -m "feat(mobile): SVG 折れ線グラフと KPI カードを追加"
```

---

## Task 8-17: 5 タブ化とダッシュボード画面

**Files:**

- Modify: `apps/mobile/src/app/(owner)/(tabs)/_layout.tsx`（Phase 5 が作る 2 タブ構成を 5 タブに拡張）
- Modify: `apps/mobile/src/app/(owner)/(tabs)/_layout.test.tsx`
- Modify: `apps/mobile/src/app/(owner)/(tabs)/dashboard.tsx`
- Modify: `apps/mobile/src/app/(owner)/(tabs)/dashboard.test.tsx`
- Create: `apps/mobile/src/features/owner/use-active-shop.ts`
- Create: `apps/mobile/src/features/owner/use-active-shop.test.tsx`
- Create: `apps/mobile/src/components/owner/range-selector.tsx`
- Create: `apps/mobile/src/components/owner/range-selector.test.tsx`

**Interfaces:**

- Consumes: `useOwnedShops` / `useShopStats` / `useApplication`（8-15）、`KpiCard` / `KpiFormat`（8-16）、`LineChart`（8-16）、`STATS_RANGE_OPTIONS` / `KPI_LABELS`（8-15）、`Button` / `Card` / `Badge` / `EmptyState` / `ErrorState` / `Skeleton`（既存プリミティブ）、`OWNER_ONBOARDING_STATUS_ROUTE`（`constants/auth.ts`、**実ファイルで確認済み**）
- Produces:
  - `useActiveShop(): { shopId: string | null; shops: readonly OwnedShop[]; isLoading: boolean; isError: boolean; refetch: () => void; selectShop: (shopId: string) => void }`
  - `RangeSelector({ value, onChange, testID }: RangeSelectorProps)`
  - `(owner)/(tabs)/_layout.tsx` が `dashboard` / `shop` / `reservations` / `reviews` / `account` の 5 タブを持つ

### タブの並びと、予約タブに触らない理由

| 位置 | ルート名       | 画面           | 担当フェーズ                              |
| ---- | -------------- | -------------- | ----------------------------------------- |
| 1    | `dashboard`    | ダッシュボード | Phase 8（この Task）                      |
| 2    | `shop`         | 店舗情報ハブ   | Phase 8（Task 8-18）                      |
| 3    | `reservations` | 予約           | **Phase 7。Phase 8 はファイルを作らない** |
| 4    | `reviews`      | レビュー       | Phase 8（Task 8-21）                      |
| 5    | `account`      | アカウント     | Phase 8（この Task）                      |

`_layout.tsx` には `reservations` の `<Tabs.Screen>` を**書く**。書かないとタブに出ないためである。しかし `reservations.tsx` 本体は Phase 7 が作るので、**Phase 8 の作業中はこのタブを押すと expo-router の「Unmatched Route」になる。** これは想定どおりで、`_layout.test.tsx` では「5 つの `Tabs.Screen` が定義されていること」だけを検証し、`reservations.tsx` のレンダリングはテストしない。

**Phase 7 と Phase 8 が同じ `_layout.tsx` を触るので、先にマージされたほうに合わせて後から入るほうが追記する。** 競合したら「5 タブ・上の並び」を正とする。

### 「アクティブな店舗」をフックに閉じる理由

Phase 8 のほぼ全画面が `shopId` を必要とする。各画面が個別に `useOwnedShops()` を呼んで `data?.[0]?.id` を取ると、

- 店舗が 0 件のときの分岐が画面の数だけ増える
- 将来「複数店舗の切り替え」を足すとき、全画面を直すことになる

`useActiveShop` に閉じておけば、画面側は `shopId === null` の 1 分岐だけを見ればよい。**MVP では「最初の 1 店舗」を自動選択するが、`selectShop` を最初から生やしておくことで、複数店舗対応が画面の変更なしに入る。**

- [ ] **Step 1: `useActiveShop` の失敗するテストを書く**

```tsx
// apps/mobile/src/features/owner/use-active-shop.test.tsx
import { act, describe, expect, it, jest } from '@jest/globals';
import { renderHook, waitFor } from '@testing-library/react-native';

import { createQueryWrapper } from './testing/query-wrapper';
import { useActiveShop } from './use-active-shop';

jest.mock('./api');
const mockedApi = jest.requireMock<typeof import('./api')>('./api');

const shop = (id: string, name: string) => ({
  id,
  name,
  status: 'published',
  ratingAvg: 0,
  ratingCount: 0,
});

describe('useActiveShop', () => {
  it('読み込み中は shopId が null で isLoading が true', async () => {
    mockedApi.fetchOwnedShops.mockReturnValue(new Promise(() => undefined));
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useActiveShop(), { wrapper });
    expect(result.current.shopId).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });

  it('店舗が 1 件なら自動で選ばれる', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop('shp_1', 'ラーメン太郎')]);
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useActiveShop(), { wrapper });
    await waitFor(() => expect(result.current.shopId).toBe('shp_1'));
  });

  it('店舗が 0 件なら shopId は null のまま、isLoading も false になる', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([]);
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useActiveShop(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.shopId).toBeNull();
  });

  it('複数あるときは先頭が選ばれる', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop('shp_1', 'A'), shop('shp_2', 'B')]);
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useActiveShop(), { wrapper });
    await waitFor(() => expect(result.current.shopId).toBe('shp_1'));
  });

  it('selectShop で切り替えられる', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop('shp_1', 'A'), shop('shp_2', 'B')]);
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useActiveShop(), { wrapper });
    await waitFor(() => expect(result.current.shopId).toBe('shp_1'));
    act(() => result.current.selectShop('shp_2'));
    await waitFor(() => expect(result.current.shopId).toBe('shp_2'));
  });

  it('持っていない店舗 ID を選んでも無視する（他店の画面を開かせない）', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop('shp_1', 'A')]);
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useActiveShop(), { wrapper });
    await waitFor(() => expect(result.current.shopId).toBe('shp_1'));
    act(() => result.current.selectShop('shp_other'));
    expect(result.current.shopId).toBe('shp_1');
  });

  it('取得に失敗したら isError が true になり、shopId は null のまま', async () => {
    mockedApi.fetchOwnedShops.mockRejectedValue(new Error('落ちた'));
    const { wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useActiveShop(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.shopId).toBeNull();
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/mobile -- src/features/owner/use-active-shop.test.tsx`
Expected: FAIL。`Cannot find module './use-active-shop'`。

- [ ] **Step 3: `useActiveShop` を実装する**

```ts
// apps/mobile/src/features/owner/use-active-shop.ts
import { useCallback, useState } from 'react';

import { useOwnedShops } from './queries';
import type { OwnedShop } from './types';

export interface ActiveShop {
  readonly shopId: string | null;
  readonly shops: readonly OwnedShop[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly refetch: () => void;
  readonly selectShop: (shopId: string) => void;
}

/**
 * 「いま操作している店舗」を決める唯一の場所。
 *
 * 選択を useState で持ち、未選択（null）のときは一覧の先頭にフォールバックする。
 * 「取得後に useEffect で setState する」形にしないのは、
 * 取得完了 → 再レンダリング → setState → もう一度レンダリングという余分な 1 往復が出るため。
 */
export function useActiveShop(): ActiveShop {
  const [selectedShopId, setSelectedShopId] = useState<string | null>(null);
  const shopsQuery = useOwnedShops();
  const shops = shopsQuery.data ?? [];

  // 選択が一覧に無ければ（切り替え直後に店舗が消えた等）先頭に戻す
  const isSelectionValid = shops.some((shop) => shop.id === selectedShopId);
  const shopId = isSelectionValid ? selectedShopId : (shops[0]?.id ?? null);

  const selectShop = useCallback(
    (nextShopId: string) => {
      // 持っていない店舗を選ばせない。ここを通さないと他店の shopId で API を叩く画面が作れてしまう
      setSelectedShopId((current) =>
        shops.some((shop) => shop.id === nextShopId) ? nextShopId : current,
      );
    },
    [shops],
  );

  const refetch = useCallback(() => {
    void shopsQuery.refetch();
  }, [shopsQuery]);

  return {
    shopId,
    shops,
    isLoading: shopsQuery.isLoading,
    isError: shopsQuery.isError,
    refetch,
    selectShop,
  };
}
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/mobile -- src/features/owner/use-active-shop.test.tsx`
Expected: PASS（7 件）。

- [ ] **Step 5: `RangeSelector` のテストを書いて実装する**

```tsx
// apps/mobile/src/components/owner/range-selector.test.tsx
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { RangeSelector } from './range-selector';

describe('RangeSelector', () => {
  it('3 つの選択肢を出す', () => {
    render(<RangeSelector value={7} onChange={jest.fn()} testID="range" />);
    expect(screen.getByText('7日間')).toBeTruthy();
    expect(screen.getByText('30日間')).toBeTruthy();
    expect(screen.getByText('90日間')).toBeTruthy();
  });

  it('選択中の項目には選択状態が付く', () => {
    render(<RangeSelector value={30} onChange={jest.fn()} testID="range" />);
    expect(screen.getByTestId('range-30').props.accessibilityState).toMatchObject({
      selected: true,
    });
  });

  it('選択中でない項目には選択状態が付かない', () => {
    render(<RangeSelector value={30} onChange={jest.fn()} testID="range" />);
    expect(screen.getByTestId('range-7').props.accessibilityState).toMatchObject({
      selected: false,
    });
  });

  it('押すと onChange に日数が渡る', () => {
    const onChange = jest.fn();
    render(<RangeSelector value={7} onChange={onChange} testID="range" />);
    fireEvent.press(screen.getByTestId('range-90'));
    expect(onChange).toHaveBeenCalledWith(90);
  });

  it('選択中の項目を押しても onChange は呼ばれる（再取得の意図があるため握りつぶさない）', () => {
    const onChange = jest.fn();
    render(<RangeSelector value={7} onChange={onChange} testID="range" />);
    fireEvent.press(screen.getByTestId('range-7'));
    expect(onChange).toHaveBeenCalledWith(7);
  });
});
```

```tsx
// apps/mobile/src/components/owner/range-selector.tsx
import { Pressable, Text, View } from 'react-native';

import { STATS_RANGE_OPTIONS } from '@/constants/owner';
import type { StatsRangeDays } from '@meshimap/core';

export interface RangeSelectorProps {
  value: StatsRangeDays;
  onChange: (days: StatsRangeDays) => void;
  testID?: string | undefined;
}

/** 選択中・非選択の見た目。Button プリミティブは単独ボタン用で、連結したセグメントは表現できない */
const SEGMENT_STYLES = {
  selected: 'bg-primary-500',
  unselected: 'bg-neutral-100',
} as const;

const SEGMENT_LABEL_STYLES = {
  selected: 'text-white',
  unselected: 'text-neutral-700',
} as const;

export function RangeSelector({ value, onChange, testID }: RangeSelectorProps) {
  return (
    <View className="flex-row gap-2" testID={testID}>
      {STATS_RANGE_OPTIONS.map((option) => {
        const state = option.days === value ? 'selected' : 'unselected';
        return (
          <Pressable
            key={option.days}
            accessibilityRole="tab"
            accessibilityState={{ selected: state === 'selected' }}
            className={`rounded-pill px-4 py-2 ${SEGMENT_STYLES[state]}`}
            onPress={() => onChange(option.days)}
            testID={testID === undefined ? undefined : `${testID}-${option.days}`}
          >
            <Text className={`text-sm ${SEGMENT_LABEL_STYLES[state]}`}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
```

Run: `npm run test -w @meshimap/mobile -- src/components/owner/range-selector.test.tsx`
Expected: PASS（5 件）。

- [ ] **Step 6: タブ構成のテストを書く**

```tsx
// apps/mobile/src/app/(owner)/(tabs)/_layout.test.tsx
import { describe, expect, it } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';

import OwnerTabsLayout from './_layout';

describe('店舗管理者のタブ', () => {
  it('5 つのタブを左から dashboard / shop / reservations / reviews / account の順で定義する', () => {
    render(<OwnerTabsLayout />);
    expect(
      screen
        .getAllByTestId('owner-tab', { includeHiddenElements: true })
        .map((node) => node.props.name),
    ).toEqual(['dashboard', 'shop', 'reservations', 'reviews', 'account']);
  });

  it('すべてのタブに日本語のタイトルが付く', () => {
    render(<OwnerTabsLayout />);
    expect(
      screen
        .getAllByTestId('owner-tab', { includeHiddenElements: true })
        .map((node) => node.props.options.title),
    ).toEqual(['ダッシュボード', '店舗情報', '予約', 'レビュー', 'アカウント']);
  });
});
```

**`Tabs` は `jest-expo` 環境では実際のナビゲータを立ち上げるため、上のような props 検査ができるように `expo-router` を `jest.mock` する。Phase 5 が `_layout.test.tsx` を作っているなら、そのモックの書き方をそのまま踏襲する。** 未確認：Phase 5 がどの形でモックしているかは、この計画を書いた時点では `apps/mobile/src/app/(owner)/` が存在しないため確認できていない。**Phase 5 のファイルを開き、既存のモックに合わせてからテストを書くこと。**

- [ ] **Step 7: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/(tabs)/_layout.test.tsx'`
Expected: FAIL。Phase 5 の 2 タブ（`dashboard`, `account` を想定）しか定義されていないので、配列の比較が `['dashboard', 'account']` vs 5 要素で落ちる。

- [ ] **Step 8: タブを 5 つにする**

```tsx
// apps/mobile/src/app/(owner)/(tabs)/_layout.tsx
import { Tabs } from 'expo-router';
import {
  CalendarCheck,
  LayoutDashboard,
  MessageSquareText,
  Store,
  UserRound,
} from 'lucide-react-native';

import { Icon } from '@/components/ui/icon';
import { COLORS } from '@/constants/theme';

/** タブの定義。並び順がそのまま画面下の並びになる */
const OWNER_TABS = [
  { name: 'dashboard', title: 'ダッシュボード', icon: LayoutDashboard },
  { name: 'shop', title: '店舗情報', icon: Store },
  // reservations.tsx の実体は Phase 7 が作る。ここではタブの枠だけ用意する
  { name: 'reservations', title: '予約', icon: CalendarCheck },
  { name: 'reviews', title: 'レビュー', icon: MessageSquareText },
  { name: 'account', title: 'アカウント', icon: UserRound },
] as const;

export default function OwnerTabsLayout() {
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: COLORS.primary[500] }}>
      {OWNER_TABS.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          testID="owner-tab"
          options={{
            title: tab.title,
            tabBarIcon: ({ color }: { color: string }) => (
              <Icon icon={tab.icon} size="lg" color={color} />
            ),
          }}
        />
      ))}
    </Tabs>
  );
}
```

**`app/` 配下のファイルは expo-router の規約で `export default` が必須なので、「default export 禁止」の例外になる（`CODING_GUIDELINES.md` に明記されている）。**

- [ ] **Step 9: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/(tabs)/_layout.test.tsx'`
Expected: PASS（2 件）。

- [ ] **Step 10: ダッシュボードのテストを書く**

```tsx
// apps/mobile/src/app/(owner)/(tabs)/dashboard.test.tsx
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { createQueryWrapper } from '@/features/owner/testing/query-wrapper';

import OwnerDashboardScreen from './dashboard';

jest.mock('@/features/owner/api');
const mockedApi = jest.requireMock<typeof import('@/features/owner/api')>('@/features/owner/api');

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const zeroSeries = { points: [], total: 0, previousTotal: 0, changeRate: null };
const shop = {
  id: 'shp_1',
  name: 'ラーメン太郎',
  status: 'published',
  ratingAvg: 4.2,
  ratingCount: 31,
};

function renderScreen() {
  const { wrapper: Wrapper } = createQueryWrapper();
  return render(<OwnerDashboardScreen />, { wrapper: Wrapper });
}

describe('ダッシュボード', () => {
  it('読み込み中はスケルトンを出す', () => {
    mockedApi.fetchOwnedShops.mockReturnValue(new Promise(() => undefined));
    renderScreen();
    expect(screen.getByTestId('dashboard-skeleton', { includeHiddenElements: true })).toBeTruthy();
  });

  it('店舗が 0 件なら空状態を出し、審査状況へ誘導する', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([]);
    mockedApi.fetchApplication.mockResolvedValue(null);
    renderScreen();
    await waitFor(() => expect(screen.getByText('まだ店舗がありません')).toBeTruthy());
    fireEvent.press(screen.getByText('審査状況を見る'));
    expect(mockPush).toHaveBeenCalledWith('/onboarding/status');
  });

  it('店舗一覧の取得に失敗したらエラー表示と再試行ボタンを出す', async () => {
    mockedApi.fetchOwnedShops.mockRejectedValue(new Error('落ちた'));
    renderScreen();
    await waitFor(() => expect(screen.getByText('再試行')).toBeTruthy());
  });

  it('KPI を 4 枚出す', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopStats.mockResolvedValue({
      days: 7,
      views: zeroSeries,
      favorites: zeroSeries,
      reservations: zeroSeries,
      ratings: zeroSeries,
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText('閲覧数')).toBeTruthy());
    expect(screen.getByText('お気に入り')).toBeTruthy();
    expect(screen.getByText('予約')).toBeTruthy();
    expect(screen.getByText('平均評価')).toBeTruthy();
  });

  it('閲覧数が全日 0 でも落ちずに 0 を表示する（Phase 8 完了時点の既定状態）', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopStats.mockResolvedValue({
      days: 7,
      views: {
        points: [{ date: '2026-09-15', value: 0 }],
        total: 0,
        previousTotal: 0,
        changeRate: null,
      },
      favorites: zeroSeries,
      reservations: zeroSeries,
      ratings: zeroSeries,
    });
    renderScreen();
    await waitFor(() => expect(screen.getAllByText('0').length).toBeGreaterThan(0));
  });

  it('期間を 30 日に変えると 30 日で取り直す', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopStats.mockResolvedValue({
      days: 7,
      views: zeroSeries,
      favorites: zeroSeries,
      reservations: zeroSeries,
      ratings: zeroSeries,
    });
    renderScreen();
    await waitFor(() => expect(mockedApi.fetchShopStats).toHaveBeenCalledWith('shp_1', 7));
    fireEvent.press(screen.getByTestId('dashboard-range-30'));
    await waitFor(() => expect(mockedApi.fetchShopStats).toHaveBeenCalledWith('shp_1', 30));
  });

  it('未対応セクションから予約一覧へ遷移できる', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopStats.mockResolvedValue({
      days: 7,
      views: zeroSeries,
      favorites: zeroSeries,
      reservations: zeroSeries,
      ratings: zeroSeries,
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText('予約を確認')).toBeTruthy());
    fireEvent.press(screen.getByText('予約を確認'));
    expect(mockPush).toHaveBeenCalledWith('/reservations');
  });

  it('統計だけ失敗したときは店舗名を残したままエラー表示にする（画面全体を消さない）', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopStats.mockRejectedValue(new Error('落ちた'));
    renderScreen();
    await waitFor(() => expect(screen.getByText('ラーメン太郎')).toBeTruthy());
    expect(screen.getByText('再試行')).toBeTruthy();
  });
});
```

- [ ] **Step 11: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/(tabs)/dashboard.test.tsx'`
Expected: FAIL。Phase 5 のダッシュボードは「ようこそ」程度の仮画面なので、`閲覧数` などが見つからず 8 件中 6 件以上が落ちる。

- [ ] **Step 12: ダッシュボードを実装する**

```tsx
// apps/mobile/src/app/(owner)/(tabs)/dashboard.tsx
import { Store } from 'lucide-react-native';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { StatsRangeDays } from '@meshimap/core';

import { LineChart } from '@/components/chart/line-chart';
import { KpiCard } from '@/components/owner/kpi-card';
import type { KpiFormat } from '@/components/owner/kpi-card';
import { RangeSelector } from '@/components/owner/range-selector';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { OWNER_ONBOARDING_STATUS_ROUTE } from '@/constants/auth';
import { KPI_LABELS, STATS_RANGE_OPTIONS } from '@/constants/owner';
import { useShopStats } from '@/features/owner/queries';
import { useActiveShop } from '@/features/owner/use-active-shop';

/** KPI の並びと表示形式。ratings だけ合計に意味が無いので平均表示にする */
const KPI_ORDER = [
  { key: 'views', format: 'count' },
  { key: 'favorites', format: 'count' },
  { key: 'reservations', format: 'count' },
  { key: 'ratings', format: 'rating' },
] as const satisfies readonly { key: keyof typeof KPI_LABELS; format: KpiFormat }[];

/** メイングラフの高さ（px）。KPI カード内のスパークラインより大きく取り、日次の起伏が読めるようにする */
const MAIN_CHART_HEIGHT = 160;
const MAIN_CHART_WIDTH = 320;

const RESERVATIONS_ROUTE = '/reservations';

/** 既定の期間。最初の選択肢（7 日）を使う */
const DEFAULT_RANGE_DAYS: StatsRangeDays = STATS_RANGE_OPTIONS[0].days;

export default function OwnerDashboardScreen() {
  const router = useRouter();
  const [rangeDays, setRangeDays] = useState<StatsRangeDays>(DEFAULT_RANGE_DAYS);
  const activeShop = useActiveShop();
  const statsQuery = useShopStats(activeShop.shopId, rangeDays);

  if (activeShop.isLoading) {
    return (
      <View className="gap-3 p-md" testID="dashboard-skeleton">
        <Skeleton height={24} width="60%" shape="text" />
        <Skeleton height={96} />
        <Skeleton height={MAIN_CHART_HEIGHT} />
      </View>
    );
  }

  if (activeShop.isError) {
    return <ErrorState description="店舗情報を取得できませんでした" onRetry={activeShop.refetch} />;
  }

  if (activeShop.shopId === null) {
    return (
      <EmptyState
        icon={Store}
        title="まだ店舗がありません"
        description="店舗の登録申請が承認されると、ここに実績が表示されます"
        action={{
          label: '審査状況を見る',
          onPress: () => router.push(OWNER_ONBOARDING_STATUS_ROUTE),
        }}
      />
    );
  }

  const shopName = activeShop.shops.find((shop) => shop.id === activeShop.shopId)?.name ?? '';

  return (
    <ScrollView contentContainerClassName="gap-4 p-md">
      <Text className="text-xl font-bold text-neutral-900">{shopName}</Text>
      <RangeSelector value={rangeDays} onChange={setRangeDays} testID="dashboard-range" />

      {statsQuery.isError ? (
        // 店舗名は残す。画面ごと消すと「どの店の話か」が分からなくなる
        <ErrorState
          description="実績を取得できませんでした"
          onRetry={() => void statsQuery.refetch()}
        />
      ) : statsQuery.data === undefined ? (
        <Skeleton height={MAIN_CHART_HEIGHT} />
      ) : (
        <>
          <View className="flex-row flex-wrap gap-3">
            {KPI_ORDER.map((kpi) => (
              <KpiCard
                key={kpi.key}
                label={KPI_LABELS[kpi.key]}
                series={statsQuery.data[kpi.key]}
                format={kpi.format}
                testID={`dashboard-kpi-${kpi.key}`}
              />
            ))}
          </View>
          <Card testID="dashboard-main-chart">
            <Text className="mb-2 text-sm text-neutral-600">{KPI_LABELS.views}の推移</Text>
            <LineChart
              values={statsQuery.data.views.points.map((point) => point.value)}
              width={MAIN_CHART_WIDTH}
              height={MAIN_CHART_HEIGHT}
              testID="dashboard-views-chart"
            />
          </Card>
        </>
      )}

      <Card testID="dashboard-pending">
        <Text className="mb-2 text-base font-semibold text-neutral-900">未対応</Text>
        {/* 予約一覧の実体は Phase 7。ここは遷移だけを担う */}
        <Button
          label="予約を確認"
          variant="secondary"
          onPress={() => router.push(RESERVATIONS_ROUTE)}
        />
      </Card>
    </ScrollView>
  );
}
```

- [ ] **Step 13: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/(tabs)/dashboard.test.tsx'`
Expected: PASS（8 件）。

- [ ] **Step 14: `account.tsx` を用意する**

Phase 5 が `(owner)/(tabs)/account.tsx` を作っていればそのまま使う。無い場合だけ、サインアウトと「審査状況」への導線を持つ最小の画面を作る。

```tsx
// apps/mobile/src/app/(owner)/(tabs)/account.tsx（Phase 5 に無い場合のみ新規）
import { useRouter } from 'expo-router';
import { ScrollView, Text } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { OWNER_ONBOARDING_STATUS_ROUTE } from '@/constants/auth';

const CAMPAIGNS_ROUTE = '/campaigns';

export default function OwnerAccountScreen() {
  const router = useRouter();
  return (
    <ScrollView contentContainerClassName="gap-4 p-md">
      <Card>
        <Text className="mb-2 text-base font-semibold text-neutral-900">店舗の管理</Text>
        <Button label="クーポン" variant="secondary" onPress={() => router.push(CAMPAIGNS_ROUTE)} />
      </Card>
      <Card>
        <Text className="mb-2 text-base font-semibold text-neutral-900">申請</Text>
        <Button
          label="審査状況"
          variant="secondary"
          onPress={() => router.push(OWNER_ONBOARDING_STATUS_ROUTE)}
        />
      </Card>
    </ScrollView>
  );
}
```

**サインアウトは Phase 5 の担当。既に `account.tsx` があるならクーポンと審査状況の 2 行を足すだけにする。**

- [ ] **Step 15: わざと壊して検証が効いていることを確認する**

`use-active-shop.ts` の `selectShop` から所有チェック（`shops.some(...)`）を外し、常に `setSelectedShopId(nextShopId)` にする。
Expected: FAIL。「持っていない店舗 ID を選んでも無視する」が落ちる。

次に `dashboard.tsx` の `statsQuery.isError` 分岐を消す。
Expected: FAIL。「統計だけ失敗したときは店舗名を残したままエラー表示にする」が落ちる。

次に `KPI_ORDER` の `ratings` の `format` を `'count'` に変える。
Expected: FAIL。`kpi-card.test.tsx` は通ってしまうが、`dashboard.test.tsx` の「平均評価」ラベルは残るため落ちない。**これは検出できない変異なので、`dashboard.test.tsx` に「平均評価の KPI カードは合計ではなく平均を出す」テストを 1 件足して殺す。** 具体的には `ratings.points` に `[4, 5]` を入れ、`getByText('4.5')` と `queryByText('9')` を検証する。**テストを足してから先へ進む（除外は選択肢にない）。**

**3 つとも確認したら元に戻し、追加テストを含めて緑になることを確認する。**

- [ ] **Step 16: カバレッジ・型・lint を通してコミット**

Run: `npm run test -w @meshimap/mobile && npm run typecheck -w @meshimap/mobile && npm run lint`
Expected: すべて成功、カバレッジ 100%。

```bash
git add 'apps/mobile/src/app/(owner)' apps/mobile/src/features/owner apps/mobile/src/components/owner
git commit -m "feat(mobile): 店舗管理者を 5 タブ化しダッシュボードを実装"
```

---

## Task 8-18: 店舗情報ハブ・基本情報・営業時間・座席

**Files:**

- Create: `apps/mobile/src/components/owner/shop-section-link.tsx`
- Create: `apps/mobile/src/components/owner/shop-section-link.test.tsx`
- Create: `apps/mobile/src/app/(owner)/(tabs)/shop.tsx`
- Create: `apps/mobile/src/app/(owner)/(tabs)/shop.test.tsx`
- Create: `apps/mobile/src/app/(owner)/shop/_layout.tsx`
- Create: `apps/mobile/src/app/(owner)/shop/basic.tsx`
- Create: `apps/mobile/src/app/(owner)/shop/basic.test.tsx`
- Create: `apps/mobile/src/app/(owner)/shop/hours.tsx`
- Create: `apps/mobile/src/app/(owner)/shop/hours.test.tsx`
- Create: `apps/mobile/src/app/(owner)/shop/seats.tsx`
- Create: `apps/mobile/src/app/(owner)/shop/seats.test.tsx`

**Interfaces:**

- Consumes: `useActiveShop`（8-17）、`useShopHours` / `useSaveShopHours` / `useCreateClosure` / `useDeleteClosure` / `useShopSeats` / `useSaveShopSeats`（8-15）、`shopBasicInputSchema` / `shopHoursInputSchema` / `shopSeatsInputSchema`（Task 8-3 の `packages/core`）、`Button` / `Card` / `Badge` / `Input` / `EmptyState` / `ErrorState` / `Skeleton` / `Icon`（既存プリミティブ）、`useForm` + `zodResolver`
- Produces:
  - `ShopSectionLink({ icon, title, description, isIncomplete, onPress, testID }: ShopSectionLinkProps)`
  - `(owner)/shop/_layout.tsx`（Stack。タイトルを日本語で持つ）
  - 3 画面（`basic` / `hours` / `seats`）

### ハブ画面を挟む理由

店舗編集は基本情報・営業時間・位置・写真・メニュー・座席の 6 区画に分かれる。これを 1 画面のロングフォームにすると、

- 保存ボタンが 1 つになり、「営業時間だけ直したいのに住所も一緒に送る」形になる
- 部分的な検証エラーで全体が保存できなくなる
- 画面のテストが組み合わせ爆発を起こす

**区画ごとに独立した画面・独立した保存にする。** ハブはその入口の一覧で、`isIncomplete` で「まだ設定していない区画」を目立たせる。公開前にオーナーが埋めるべき項目を、ハブを見るだけで把握できる。

### 未設定の判定をハブ側に置く理由

「未設定」はサーバの状態ではなく**画面の都合**である。営業時間なら「`hours` が 7 行揃っていない」、写真なら「0 枚」、座席なら「`seatCount === 0`」。これを API のフラグにすると、判定を変えるたびにサーバを直すことになる。ハブ画面のローカル関数に閉じる。

- [ ] **Step 1: `ShopSectionLink` のテストを書く**

```tsx
// apps/mobile/src/components/owner/shop-section-link.test.tsx
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Store } from 'lucide-react-native';

import { ShopSectionLink } from './shop-section-link';

describe('ShopSectionLink', () => {
  it('題と補足を出す', () => {
    render(
      <ShopSectionLink
        icon={Store}
        title="営業時間"
        description="月〜金 11:00-22:00"
        onPress={jest.fn()}
        testID="link"
      />,
    );
    expect(screen.getByText('営業時間')).toBeTruthy();
    expect(screen.getByText('月〜金 11:00-22:00')).toBeTruthy();
  });

  it('未設定なら「未設定」バッジを出す', () => {
    render(
      <ShopSectionLink icon={Store} title="写真" isIncomplete onPress={jest.fn()} testID="link" />,
    );
    expect(screen.getByText('未設定')).toBeTruthy();
  });

  it('設定済みならバッジを出さない', () => {
    render(
      <ShopSectionLink
        icon={Store}
        title="写真"
        description="3 枚"
        onPress={jest.fn()}
        testID="link"
      />,
    );
    expect(screen.queryByText('未設定')).toBeNull();
  });

  it('押すと onPress が呼ばれる', () => {
    const onPress = jest.fn();
    render(<ShopSectionLink icon={Store} title="写真" onPress={onPress} testID="link" />);
    fireEvent.press(screen.getByTestId('link'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('未設定であることが読み上げラベルにも載る（バッジの色だけで伝えない）', () => {
    render(
      <ShopSectionLink icon={Store} title="写真" isIncomplete onPress={jest.fn()} testID="link" />,
    );
    expect(screen.getByLabelText('写真、未設定')).toBeTruthy();
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認し、`ShopSectionLink` を実装する**

Run: `npm run test -w @meshimap/mobile -- src/components/owner/shop-section-link.test.tsx`
Expected: FAIL（`Cannot find module './shop-section-link'`）。

```tsx
// apps/mobile/src/components/owner/shop-section-link.tsx
import type { LucideIcon } from 'lucide-react-native';
import { ChevronRight } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';

export interface ShopSectionLinkProps {
  icon: LucideIcon;
  title: string;
  description?: string | undefined;
  isIncomplete?: boolean | undefined;
  onPress: () => void;
  testID?: string | undefined;
}

const INCOMPLETE_LABEL = '未設定';

/** 読み上げの区切り。Input プリミティブと同じ読点を使う */
const ACCESSIBILITY_LABEL_SEPARATOR = '、';

function buildAccessibilityLabel(title: string, isIncomplete: boolean): string {
  return isIncomplete ? `${title}${ACCESSIBILITY_LABEL_SEPARATOR}${INCOMPLETE_LABEL}` : title;
}

export function ShopSectionLink({
  icon,
  title,
  description,
  isIncomplete = false,
  onPress,
  testID,
}: ShopSectionLinkProps) {
  return (
    <Card onPress={onPress} padding="md" testID={testID}>
      <View
        accessible
        accessibilityLabel={buildAccessibilityLabel(title, isIncomplete)}
        className="flex-row items-center gap-3"
      >
        <Icon icon={icon} size="lg" />
        <View className="flex-1">
          <View className="flex-row items-center gap-2">
            <Text className="text-base font-semibold text-neutral-900">{title}</Text>
            {/* 色だけで状態を伝えないよう、文言つきのバッジにする */}
            {isIncomplete && <Badge label={INCOMPLETE_LABEL} tone="warning" />}
          </View>
          {description !== undefined && (
            <Text className="mt-1 text-sm text-neutral-600">{description}</Text>
          )}
        </View>
        <Icon icon={ChevronRight} size="md" />
      </View>
    </Card>
  );
}
```

Run: `npm run test -w @meshimap/mobile -- src/components/owner/shop-section-link.test.tsx`
Expected: PASS（5 件）。

- [ ] **Step 3: ハブ画面のテストを書く**

```tsx
// apps/mobile/src/app/(owner)/(tabs)/shop.test.tsx
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { createQueryWrapper } from '@/features/owner/testing/query-wrapper';

import OwnerShopScreen from './shop';

jest.mock('@/features/owner/api');
const mockedApi = jest.requireMock<typeof import('@/features/owner/api')>('@/features/owner/api');

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const shop = {
  id: 'shp_1',
  name: 'ラーメン太郎',
  status: 'published',
  ratingAvg: 4.2,
  ratingCount: 31,
};
const fullWeekHours = Array.from({ length: 7 }, (_, dayOfWeek) => ({
  dayOfWeek,
  openTime: '11:00',
  closeTime: '22:00',
  isClosed: false,
}));

function renderScreen() {
  const { wrapper: Wrapper } = createQueryWrapper();
  return render(<OwnerShopScreen />, { wrapper: Wrapper });
}

describe('店舗情報ハブ', () => {
  it('6 区画のリンクを出す', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopHours.mockResolvedValue({ hours: fullWeekHours, closures: [] });
    mockedApi.fetchShopPhotos.mockResolvedValue([]);
    mockedApi.fetchShopSeats.mockResolvedValue({
      seatCount: 12,
      hasCounter: true,
      hasPrivateRoom: false,
      smokingPolicy: 'no-smoking',
    });
    mockedApi.fetchMenuTree.mockResolvedValue({ categories: [] });
    renderScreen();
    await waitFor(() => expect(screen.getByText('基本情報')).toBeTruthy());
    for (const title of ['基本情報', '営業時間', '位置', '写真', 'メニュー', '座席']) {
      expect(screen.getByText(title)).toBeTruthy();
    }
  });

  it('写真が 0 枚なら写真区画に「未設定」が付く', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopHours.mockResolvedValue({ hours: fullWeekHours, closures: [] });
    mockedApi.fetchShopPhotos.mockResolvedValue([]);
    mockedApi.fetchShopSeats.mockResolvedValue({
      seatCount: 12,
      hasCounter: true,
      hasPrivateRoom: false,
      smokingPolicy: 'no-smoking',
    });
    mockedApi.fetchMenuTree.mockResolvedValue({ categories: [] });
    renderScreen();
    await waitFor(() => expect(screen.getByLabelText('写真、未設定')).toBeTruthy());
  });

  it('営業時間が 7 日分揃っていなければ「未設定」が付く', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopHours.mockResolvedValue({ hours: fullWeekHours.slice(0, 3), closures: [] });
    mockedApi.fetchShopPhotos.mockResolvedValue([]);
    mockedApi.fetchShopSeats.mockResolvedValue({
      seatCount: 12,
      hasCounter: true,
      hasPrivateRoom: false,
      smokingPolicy: 'no-smoking',
    });
    mockedApi.fetchMenuTree.mockResolvedValue({ categories: [] });
    renderScreen();
    await waitFor(() => expect(screen.getByLabelText('営業時間、未設定')).toBeTruthy());
  });

  it('区画を押すと対応する画面へ遷移する', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopHours.mockResolvedValue({ hours: fullWeekHours, closures: [] });
    mockedApi.fetchShopPhotos.mockResolvedValue([]);
    mockedApi.fetchShopSeats.mockResolvedValue({
      seatCount: 12,
      hasCounter: true,
      hasPrivateRoom: false,
      smokingPolicy: 'no-smoking',
    });
    mockedApi.fetchMenuTree.mockResolvedValue({ categories: [] });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('shop-section-hours')).toBeTruthy());
    fireEvent.press(screen.getByTestId('shop-section-hours'));
    expect(mockPush).toHaveBeenCalledWith('/shop/hours');
  });

  it('店舗が無いときは空状態を出す', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([]);
    renderScreen();
    await waitFor(() => expect(screen.getByText('まだ店舗がありません')).toBeTruthy());
  });
});
```

- [ ] **Step 4: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/(tabs)/shop.test.tsx'`
Expected: FAIL。`Cannot find module './shop'`。

- [ ] **Step 5: ハブ画面を実装する**

```tsx
// apps/mobile/src/app/(owner)/(tabs)/shop.tsx
import { useRouter } from 'expo-router';
import { Armchair, Clock, ImageIcon, MapPin, Store, UtensilsCrossed } from 'lucide-react-native';
import { ScrollView, Text } from 'react-native';

import { ShopSectionLink } from '@/components/owner/shop-section-link';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { OWNER_ONBOARDING_STATUS_ROUTE } from '@/constants/auth';
import { useMenuTree, useShopHours, useShopPhotos, useShopSeats } from '@/features/owner/queries';
import { useActiveShop } from '@/features/owner/use-active-shop';

/** 1 週間の日数。営業時間が全曜日ぶん揃っているかの判定に使う */
const DAYS_IN_WEEK = 7;

/** 区画の定義。並びがそのまま画面の並びになる */
const SHOP_SECTIONS = [
  { key: 'basic', title: '基本情報', icon: Store, route: '/shop/basic' },
  { key: 'hours', title: '営業時間', icon: Clock, route: '/shop/hours' },
  { key: 'location', title: '位置', icon: MapPin, route: '/shop/location' },
  { key: 'photos', title: '写真', icon: ImageIcon, route: '/shop/photos' },
  { key: 'menu', title: 'メニュー', icon: UtensilsCrossed, route: '/shop/menu' },
  { key: 'seats', title: '座席', icon: Armchair, route: '/shop/seats' },
] as const;

export default function OwnerShopScreen() {
  const router = useRouter();
  const activeShop = useActiveShop();
  const hoursQuery = useShopHours(activeShop.shopId);
  const photosQuery = useShopPhotos(activeShop.shopId);
  const menuQuery = useMenuTree(activeShop.shopId);
  const seatsQuery = useShopSeats(activeShop.shopId);

  if (activeShop.isLoading) {
    return <Skeleton height={320} testID="shop-skeleton" />;
  }
  if (activeShop.isError) {
    return <ErrorState description="店舗情報を取得できませんでした" onRetry={activeShop.refetch} />;
  }
  if (activeShop.shopId === null) {
    return (
      <EmptyState
        icon={Store}
        title="まだ店舗がありません"
        description="店舗の登録申請が承認されると、ここから編集できます"
        action={{
          label: '審査状況を見る',
          onPress: () => router.push(OWNER_ONBOARDING_STATUS_ROUTE),
        }}
      />
    );
  }

  const photoCount = photosQuery.data?.length ?? 0;
  const menuItemCount = (menuQuery.data?.categories ?? []).reduce(
    (total, category) => total + category.items.length,
    0,
  );
  const hoursCount = hoursQuery.data?.hours.length ?? 0;
  const seatCount = seatsQuery.data?.seatCount ?? 0;

  /**
   * 「未設定」の判定はここだけに置く。
   * サーバのフラグにしないのは、これが画面の都合（公開前に埋めてほしい項目）であり、
   * 判定を変えるたびに API を直したくないため。
   * 基本情報と位置は申請時に必ず入っているので、未設定になることがない。
   */
  const incompleteByKey: Record<string, boolean> = {
    basic: false,
    hours: hoursCount < DAYS_IN_WEEK,
    location: false,
    photos: photoCount === 0,
    menu: menuItemCount === 0,
    seats: seatCount === 0,
  };

  const descriptionByKey: Record<string, string | undefined> = {
    basic: activeShop.shops.find((shop) => shop.id === activeShop.shopId)?.name,
    hours: hoursCount === 0 ? undefined : `${hoursCount} 日分を設定済み`,
    location: undefined,
    photos: photoCount === 0 ? undefined : `${photoCount} 枚`,
    menu: menuItemCount === 0 ? undefined : `${menuItemCount} 品`,
    seats: seatCount === 0 ? undefined : `${seatCount} 席`,
  };

  return (
    <ScrollView contentContainerClassName="gap-3 p-md">
      <Text className="text-sm text-neutral-600">公開ページに表示される情報を編集します</Text>
      {SHOP_SECTIONS.map((section) => (
        <ShopSectionLink
          key={section.key}
          icon={section.icon}
          title={section.title}
          description={descriptionByKey[section.key]}
          isIncomplete={incompleteByKey[section.key]}
          onPress={() => router.push(section.route)}
          testID={`shop-section-${section.key}`}
        />
      ))}
    </ScrollView>
  );
}
```

- [ ] **Step 6: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/(tabs)/shop.test.tsx'`
Expected: PASS（5 件）。

- [ ] **Step 7: `shop/_layout.tsx` を作る**

```tsx
// apps/mobile/src/app/(owner)/shop/_layout.tsx
import { Stack } from 'expo-router';

/** 画面ごとのヘッダタイトル。ファイル名と 1 対 1 で対応させる */
const SHOP_STACK_TITLES = [
  { name: 'basic', title: '基本情報' },
  { name: 'hours', title: '営業時間' },
  { name: 'location', title: '位置' },
  { name: 'photos', title: '写真' },
  { name: 'seats', title: '座席' },
  { name: 'menu/index', title: 'メニュー' },
  { name: 'menu/[menuItemId]', title: 'メニュー編集' },
] as const;

export default function OwnerShopStackLayout() {
  return (
    <Stack>
      {SHOP_STACK_TITLES.map((screen) => (
        <Stack.Screen key={screen.name} name={screen.name} options={{ title: screen.title }} />
      ))}
    </Stack>
  );
}
```

- [ ] **Step 8: 営業時間画面のテストを書く**

```tsx
// apps/mobile/src/app/(owner)/shop/hours.test.tsx
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { createQueryWrapper } from '@/features/owner/testing/query-wrapper';

import OwnerShopHoursScreen from './hours';

jest.mock('@/features/owner/api');
const mockedApi = jest.requireMock<typeof import('@/features/owner/api')>('@/features/owner/api');
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), push: jest.fn() }) }));

const shop = {
  id: 'shp_1',
  name: 'ラーメン太郎',
  status: 'published',
  ratingAvg: 0,
  ratingCount: 0,
};
const fullWeekHours = Array.from({ length: 7 }, (_, dayOfWeek) => ({
  dayOfWeek,
  openTime: '11:00',
  closeTime: '22:00',
  isClosed: false,
}));

function renderScreen() {
  const { wrapper: Wrapper } = createQueryWrapper();
  return render(<OwnerShopHoursScreen />, { wrapper: Wrapper });
}

describe('営業時間画面', () => {
  it('曜日を日〜土の 7 行で出す', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopHours.mockResolvedValue({ hours: fullWeekHours, closures: [] });
    renderScreen();
    await waitFor(() => expect(screen.getByText('日曜日')).toBeTruthy());
    for (const label of ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('API が 3 日分しか返さなくても 7 行を出す（残りは定休日の初期値）', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopHours.mockResolvedValue({ hours: fullWeekHours.slice(0, 3), closures: [] });
    renderScreen();
    await waitFor(() => expect(screen.getByText('土曜日')).toBeTruthy());
    expect(screen.getByTestId('hours-closed-6').props.accessibilityState).toMatchObject({
      checked: true,
    });
  });

  it('定休日に切り替えると時刻入力が消える', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopHours.mockResolvedValue({ hours: fullWeekHours, closures: [] });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('hours-open-1')).toBeTruthy());
    fireEvent.press(screen.getByTestId('hours-closed-1'));
    expect(screen.queryByTestId('hours-open-1')).toBeNull();
  });

  it('時刻の形式が不正なら保存せずエラー文言を出す', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopHours.mockResolvedValue({ hours: fullWeekHours, closures: [] });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('hours-open-1')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('hours-open-1'), '25:00');
    fireEvent.press(screen.getByText('保存'));
    await waitFor(() => expect(screen.getByText('HH:MM の形式で入力してください')).toBeTruthy());
    expect(mockedApi.saveShopHours).not.toHaveBeenCalled();
  });

  it('保存を押すと 7 日分をまとめて送る', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopHours.mockResolvedValue({ hours: fullWeekHours, closures: [] });
    mockedApi.saveShopHours.mockResolvedValue({ hours: fullWeekHours, closures: [] });
    renderScreen();
    await waitFor(() => expect(screen.getByText('保存')).toBeTruthy());
    fireEvent.press(screen.getByText('保存'));
    await waitFor(() => expect(mockedApi.saveShopHours).toHaveBeenCalledTimes(1));
    expect(mockedApi.saveShopHours.mock.calls[0]?.[1]).toHaveLength(7);
  });

  it('臨時休業を追加できる', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopHours.mockResolvedValue({ hours: fullWeekHours, closures: [] });
    mockedApi.createClosure.mockResolvedValue({
      hours: fullWeekHours,
      closures: [{ id: 'shc_1', closedOn: '2026-12-31', reason: '年末休業' }],
    });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('closure-date')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('closure-date'), '2026-12-31');
    fireEvent.changeText(screen.getByTestId('closure-reason'), '年末休業');
    fireEvent.press(screen.getByText('臨時休業を追加'));
    await waitFor(() =>
      expect(mockedApi.createClosure).toHaveBeenCalledWith('shp_1', '2026-12-31', '年末休業'),
    );
  });

  it('臨時休業の日付が空なら追加できない', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopHours.mockResolvedValue({ hours: fullWeekHours, closures: [] });
    renderScreen();
    await waitFor(() => expect(screen.getByText('臨時休業を追加')).toBeTruthy());
    fireEvent.press(screen.getByText('臨時休業を追加'));
    await waitFor(() => expect(screen.getByText('日付を入力してください')).toBeTruthy());
    expect(mockedApi.createClosure).not.toHaveBeenCalled();
  });

  it('臨時休業を削除できる', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopHours.mockResolvedValue({
      hours: fullWeekHours,
      closures: [{ id: 'shc_1', closedOn: '2026-12-31', reason: '年末休業' }],
    });
    mockedApi.deleteClosure.mockResolvedValue(undefined);
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('closure-delete-shc_1')).toBeTruthy());
    fireEvent.press(screen.getByTestId('closure-delete-shc_1'));
    await waitFor(() => expect(mockedApi.deleteClosure).toHaveBeenCalledWith('shp_1', 'shc_1'));
  });

  it('保存に失敗したらエラー文言を出す（画面は残す）', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopHours.mockResolvedValue({ hours: fullWeekHours, closures: [] });
    mockedApi.saveShopHours.mockRejectedValue(new Error('落ちた'));
    renderScreen();
    await waitFor(() => expect(screen.getByText('保存')).toBeTruthy());
    fireEvent.press(screen.getByText('保存'));
    await waitFor(() => expect(screen.getByText('保存できませんでした')).toBeTruthy());
    expect(screen.getByText('日曜日')).toBeTruthy();
  });
});
```

- [ ] **Step 9: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/shop/hours.test.tsx'`
Expected: FAIL。`Cannot find module './hours'`。

- [ ] **Step 10: 営業時間画面を実装する**

```tsx
// apps/mobile/src/app/(owner)/shop/hours.tsx
import { zodResolver } from '@hookform/resolvers/zod';
import { Trash2 } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { shopHoursInputSchema } from '@meshimap/core';
import type { ShopHoursInput } from '@meshimap/core';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useCreateClosure,
  useDeleteClosure,
  useSaveShopHours,
  useShopHours,
} from '@/features/owner/queries';
import type { ShopHour } from '@/features/owner/types';
import { useActiveShop } from '@/features/owner/use-active-shop';

/** 曜日ラベル。配列の添字が dayOfWeek（0 = 日曜）と一致する */
const DAY_LABELS = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'] as const;

const SAVE_ERROR_MESSAGE = '保存できませんでした';
const CLOSURE_DATE_REQUIRED_MESSAGE = '日付を入力してください';

/**
 * API が返す行を必ず 7 行に揃える。
 * 揃えないと「設定したことがない曜日」が画面に出ず、オーナーが埋めようがなくなる。
 * 未設定の曜日は定休日を初期値にする（うっかり 24 時間営業として公開されるより安全）。
 */
function toFullWeek(hours: readonly ShopHour[]): ShopHour[] {
  return DAY_LABELS.map((_, dayOfWeek) => {
    const found = hours.find((hour) => hour.dayOfWeek === dayOfWeek);
    return found ?? { dayOfWeek, openTime: null, closeTime: null, isClosed: true };
  });
}

export default function OwnerShopHoursScreen() {
  const activeShop = useActiveShop();
  const hoursQuery = useShopHours(activeShop.shopId);
  const saveHours = useSaveShopHours(activeShop.shopId ?? '');
  const createClosure = useCreateClosure(activeShop.shopId ?? '');
  const deleteClosure = useDeleteClosure(activeShop.shopId ?? '');

  const form = useForm<ShopHoursInput>({
    resolver: zodResolver(shopHoursInputSchema),
    defaultValues: { hours: [] },
  });
  const { reset } = form;

  const [closureDate, setClosureDate] = useState('');
  const [closureReason, setClosureReason] = useState('');
  const [closureError, setClosureError] = useState<string | null>(null);

  // 取得できた時点でフォームに流し込む。取得前に reset すると空で上書きしてしまう
  useEffect(() => {
    if (hoursQuery.data !== undefined) {
      reset({ hours: toFullWeek(hoursQuery.data.hours) });
    }
  }, [hoursQuery.data, reset]);

  if (activeShop.shopId === null || hoursQuery.isLoading) {
    return <Skeleton height={400} testID="hours-skeleton" />;
  }
  if (hoursQuery.isError) {
    return (
      <ErrorState
        description="営業時間を取得できませんでした"
        onRetry={() => void hoursQuery.refetch()}
      />
    );
  }

  const onSubmit = form.handleSubmit((values) => {
    saveHours.mutate(values.hours);
  });

  const onAddClosure = () => {
    if (closureDate === '') {
      setClosureError(CLOSURE_DATE_REQUIRED_MESSAGE);
      return;
    }
    setClosureError(null);
    createClosure.mutate({
      closedOn: closureDate,
      reason: closureReason === '' ? null : closureReason,
    });
  };

  return (
    <ScrollView contentContainerClassName="gap-3 p-md">
      {DAY_LABELS.map((label, dayOfWeek) => (
        <Card key={label} testID={`hours-row-${dayOfWeek}`}>
          <View className="flex-row items-center justify-between">
            <Text className="text-base text-neutral-900">{label}</Text>
            <Controller
              control={form.control}
              name={`hours.${dayOfWeek}.isClosed`}
              render={({ field }) => (
                <Switch
                  accessibilityLabel={`${label}は定休日`}
                  accessibilityState={{ checked: field.value }}
                  value={field.value}
                  onValueChange={field.onChange}
                  testID={`hours-closed-${dayOfWeek}`}
                />
              )}
            />
          </View>
          {/* 定休日なら時刻欄を出さない。出したままだと「休みなのに時刻がある」矛盾した入力ができる */}
          {!form.watch(`hours.${dayOfWeek}.isClosed`) && (
            <View className="mt-2 flex-row gap-2">
              <Controller
                control={form.control}
                name={`hours.${dayOfWeek}.openTime`}
                render={({ field, fieldState }) => (
                  <View className="flex-1">
                    <Input
                      label="開店"
                      value={field.value ?? ''}
                      onChangeText={field.onChange}
                      placeholder="11:00"
                      errorMessage={fieldState.error?.message}
                      testID={`hours-open-${dayOfWeek}`}
                    />
                  </View>
                )}
              />
              <Controller
                control={form.control}
                name={`hours.${dayOfWeek}.closeTime`}
                render={({ field, fieldState }) => (
                  <View className="flex-1">
                    <Input
                      label="閉店"
                      value={field.value ?? ''}
                      onChangeText={field.onChange}
                      placeholder="22:00"
                      errorMessage={fieldState.error?.message}
                      testID={`hours-close-${dayOfWeek}`}
                    />
                  </View>
                )}
              />
            </View>
          )}
        </Card>
      ))}

      <Button label="保存" onPress={onSubmit} isLoading={saveHours.isPending} />
      {saveHours.isError && <Text className="text-sm text-red-500">{SAVE_ERROR_MESSAGE}</Text>}

      <Card testID="closures">
        <Text className="mb-2 text-base font-semibold text-neutral-900">臨時休業</Text>
        {(hoursQuery.data?.closures ?? []).map((closure) => (
          <View key={closure.id} className="flex-row items-center justify-between py-2">
            <Text className="text-sm text-neutral-800">
              {closure.closedOn}
              {closure.reason === null ? '' : `（${closure.reason}）`}
            </Text>
            <Pressable
              accessibilityLabel={`${closure.closedOn}の臨時休業を削除`}
              onPress={() => deleteClosure.mutate(closure.id)}
              testID={`closure-delete-${closure.id}`}
            >
              <Icon icon={Trash2} size="md" />
            </Pressable>
          </View>
        ))}
        <Input
          label="日付"
          value={closureDate}
          onChangeText={setClosureDate}
          placeholder="2026-12-31"
          errorMessage={closureError ?? undefined}
          testID="closure-date"
        />
        <Input
          label="理由"
          value={closureReason}
          onChangeText={setClosureReason}
          testID="closure-reason"
        />
        <Button
          label="臨時休業を追加"
          variant="secondary"
          onPress={onAddClosure}
          isLoading={createClosure.isPending}
        />
      </Card>
    </ScrollView>
  );
}
```

- [ ] **Step 11: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/shop/hours.test.tsx'`
Expected: PASS（9 件）。

- [ ] **Step 12: 基本情報画面を書く**

テストは `hours.test.tsx` と同じ形で、次の 7 件を書く。

1. 「取得した店舗名・かな・説明・電話・住所が初期値に入る」
2. 「店舗名を空にして保存を押すと『店舗名を入力してください』が出て、API を呼ばない」
3. 「かなにカタカナ以外を入れると『全角カタカナで入力してください』が出る」
4. 「電話番号にハイフン以外の記号を入れると形式エラーが出る」
5. 「予算は下限 > 上限なら『下限は上限以下にしてください』が出る」
6. 「妥当な値で保存を押すと `updateShop` が 1 回だけ呼ばれる」
7. 「保存に失敗したら『保存できませんでした』を出し、入力値は消えない」

実装は `hours.tsx` と同じ構成で、`useForm<ShopBasicInput>({ resolver: zodResolver(shopBasicInputSchema) })` に `Input` プリミティブを `Controller` で束ねる。**保存先は Phase 4 の `PATCH /shops/:shopId`（Task 8-4 で回帰テストを足したもの）を使う。新しいエンドポイントは作らない。**

`features/owner/api.ts` に次を足す。

```ts
export type ShopBasicUpdate = {
  readonly name: string;
  readonly nameKana: string;
  readonly description: string | null;
  readonly phone: string | null;
  readonly website: string | null;
  readonly postalCode: string;
  readonly address: string;
  readonly budgetDinnerMin: number | null;
  readonly budgetDinnerMax: number | null;
};

export function updateShopBasic(shopId: string, input: ShopBasicUpdate): Promise<OwnedShop> {
  return request(`/shops/${encodeSegment(shopId)}`, ownedShopSchema, jsonInit('PATCH', input));
}
```

対応するフック `useUpdateShopBasic(shopId)` は `ownerQueryKeys.shops()` と `ownerQueryKeys.shop(shopId)` の両方を無効化する（店舗名は一覧にも出るため）。

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/shop/basic.test.tsx'`
Expected: PASS（7 件）。

- [ ] **Step 13: 座席画面を書く**

テストは次の 6 件。

1. 「取得した座席数・カウンター有無・個室有無・喫煙区分が初期値に入る」
2. 「座席数に負の数を入れると『0 以上で入力してください』が出て、API を呼ばない」
3. 「座席数を空にすると『座席数を入力してください』が出る」
4. 「喫煙区分は 3 択（禁煙 / 喫煙可 / 分煙）で、選ぶと選択状態が移る」
5. 「妥当な値で保存を押すと `saveShopSeats` が 1 回呼ばれる」
6. 「保存に失敗したら『保存できませんでした』を出す」

実装は `Input`（座席数）+ `Switch` ×2 + `RangeSelector` と同じ形のセグメント（喫煙区分）。**セグメントは `RangeSelector` をそのまま使えないので、`components/owner/segmented-control.tsx` として汎化し、`RangeSelector` をその薄いラッパにする。** 同じ見た目のものを 2 つ書かない（`CLAUDE.md` の「同じロジックが 2 箇所以上に出現したら共通化」に従う）。

```tsx
// apps/mobile/src/components/owner/segmented-control.tsx
export interface SegmentedControlOption<TValue extends string | number> {
  readonly value: TValue;
  readonly label: string;
}

export interface SegmentedControlProps<TValue extends string | number> {
  options: readonly SegmentedControlOption<TValue>[];
  value: TValue;
  onChange: (value: TValue) => void;
  testID?: string | undefined;
}
```

`RangeSelector` は `<SegmentedControl options={STATS_RANGE_OPTIONS.map(...)} ... />` を返すだけになる。**`range-selector.test.tsx` の 5 件はそのまま通らなければならない**（通らなければ汎化で挙動が変わっている）。

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/shop/seats.test.tsx' src/components/owner/range-selector.test.tsx src/components/owner/segmented-control.test.tsx`
Expected: PASS。

- [ ] **Step 14: わざと壊して検証が効いていることを確認する**

`hours.tsx` の `toFullWeek` を `(hours) => [...hours]` に変える（7 行に揃えない）。
Expected: FAIL。「API が 3 日分しか返さなくても 7 行を出す」が落ちる。

次に `hours.tsx` の `if (closureDate === '')` ガードを消す。
Expected: FAIL。「臨時休業の日付が空なら追加できない」が落ちる。

次に `shop.tsx` の `incompleteByKey.hours` を `false` 固定にする。
Expected: FAIL。「営業時間が 7 日分揃っていなければ『未設定』が付く」が落ちる。

**3 つとも確認したら元に戻す。**

- [ ] **Step 15: カバレッジ・型・lint を通してコミット**

Run: `npm run test -w @meshimap/mobile && npm run typecheck -w @meshimap/mobile && npm run lint`
Expected: すべて成功、カバレッジ 100%。

```bash
git add 'apps/mobile/src/app/(owner)' apps/mobile/src/components/owner apps/mobile/src/features/owner
git commit -m "feat(mobile): 店舗情報ハブと基本情報・営業時間・座席の編集画面を追加"
```

---

## Task 8-19: 位置ピンドラッグと写真管理

**Files:**

- Create: `apps/mobile/src/app/(owner)/shop/location.tsx`
- Create: `apps/mobile/src/app/(owner)/shop/location.test.tsx`
- Create: `apps/mobile/src/app/(owner)/shop/photos.tsx`
- Create: `apps/mobile/src/app/(owner)/shop/photos.test.tsx`
- Create: `apps/mobile/src/components/owner/photo-tile.tsx`
- Create: `apps/mobile/src/components/owner/photo-tile.test.tsx`
- Create: `apps/mobile/src/features/owner/pick-image.ts`
- Create: `apps/mobile/src/features/owner/pick-image.test.ts`
- Create: `apps/mobile/src/features/owner/move-item.ts`
- Create: `apps/mobile/src/features/owner/move-item.test.ts`

**Interfaces:**

- Consumes: `useActiveShop`（8-17）、`useShopPhotos` / `useUploadShopPhoto` / `useUpdateShopPhoto` / `useReorderShopPhotos` / `useDeleteShopPhoto`（8-15）、`PhotoUploadSource`（8-15）、`updateShopBasic`（8-18 で追加）、`react-native-maps` 1.27.2 の `MapView` / `Marker`、`expo-image-picker` ~57.0.17、`expo-image` ~57.0.5 の `Image`、`Button` / `Card` / `Badge` / `EmptyState` / `ErrorState` / `Icon` / `Skeleton`
- Produces:
  - `pickShopImage(): Promise<PhotoUploadSource | null>`
  - `moveItem<TValue>(items: readonly TValue[], fromIndex: number, toIndex: number): readonly TValue[]`
  - `PhotoTile({ photo, onSetCover, onMoveUp, onMoveDown, onDelete, canMoveUp, canMoveDown, testID }: PhotoTileProps)`
  - 2 画面（`location` / `photos`）

### geohash をクライアントで計算しない

**モバイルは緯度経度しか送らない。** geohash は `updateShopAsOwner`（Task 8-4）がサーバ側で `encodeGeohash` を呼んで書く。クライアントで計算して送ると、古いアプリが古い精度の geohash を送ってきたときに、近傍検索の結果だけが静かにおかしくなる。**「導出値はサーバが導出する」を守れば、この事故は起き得ない。**

### 並べ替えをドラッグではなく上下ボタンにする

写真の並べ替えは「ドラッグ&ドロップ」が自然に見えるが、

- `react-native-draggable-flatlist` のような追加依存が必要になる（新規ライブラリを足さない方針に反する）
- ジェスチャは RNTL では `fireEvent` で素直に再現できず、100% カバレッジを取りに行くと大量のモックが要る
- スクリーンリーダー利用時にドラッグは操作できない

**上下ボタンにすれば、`moveItem` という純関数のテストに落ちる。** 並べ替えの正しさをレンダリングなしで検証でき、アクセシビリティも確保できる。

### 地図のピンドラッグをどうテストするか

`react-native-maps` の `Marker` は `onDragEnd` に `{ nativeEvent: { coordinate: { latitude, longitude } } }` を渡す。RNTL からは `fireEvent(marker, 'dragEnd', { nativeEvent: { coordinate: {...} } })` で発火できる。**地図そのものの描画は検証しない**（ネイティブビューなので意味がない）。検証するのは「ドラッグ後に座標の表示が変わる」「保存でその座標が送られる」の 2 点だけである。

- [ ] **Step 1: `moveItem` の失敗するテストを書く**

```ts
// apps/mobile/src/features/owner/move-item.test.ts
import { describe, expect, it } from '@jest/globals';

import { moveItem } from './move-item';

describe('moveItem', () => {
  it('前へ 1 つ動かす', () => {
    expect(moveItem(['a', 'b', 'c'], 1, 0)).toEqual(['b', 'a', 'c']);
  });

  it('後ろへ 1 つ動かす', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
  });

  it('先頭から末尾へ動かす', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });

  it('同じ位置なら並びが変わらない', () => {
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
  });

  it('範囲外の移動先は無視して元の並びを返す', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 3)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
  });

  it('範囲外の移動元は無視して元の並びを返す', () => {
    expect(moveItem(['a', 'b', 'c'], 3, 0)).toEqual(['a', 'b', 'c']);
  });

  it('元の配列を書き換えない', () => {
    const original = ['a', 'b', 'c'];
    moveItem(original, 0, 2);
    expect(original).toEqual(['a', 'b', 'c']);
  });

  it('空配列でも落ちない', () => {
    expect(moveItem([], 0, 0)).toEqual([]);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/mobile -- src/features/owner/move-item.test.ts`
Expected: FAIL。`Cannot find module './move-item'`。

- [ ] **Step 3: `moveItem` を実装する**

```ts
// apps/mobile/src/features/owner/move-item.ts
/**
 * 配列の 1 要素を別の位置へ動かした新しい配列を返す。
 * 範囲外の添字は「操作できない位置を押した」を意味するので、何もせず元の並びを返す
 * （例外にすると、末尾の要素の「下へ」ボタンを押しただけでクラッシュする）。
 */
export function moveItem<TValue>(
  items: readonly TValue[],
  fromIndex: number,
  toIndex: number,
): readonly TValue[] {
  const isFromValid = fromIndex >= 0 && fromIndex < items.length;
  const isToValid = toIndex >= 0 && toIndex < items.length;
  if (!isFromValid || !isToValid) {
    return items;
  }
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) {
    return items;
  }
  next.splice(toIndex, 0, moved);
  return next;
}
```

**`noUncheckedIndexedAccess` が有効なので `splice` の戻り値は `TValue | undefined` になる。`!` で潰さず `undefined` を明示的に扱う。** この分岐は `isFromValid` が真なら実際には到達しないが、到達不能な分岐を残すとカバレッジ 100% を取れない。**到達できないコードを書かないために、`splice` ではなく `filter` + `flatMap` で書き直す案もあるが、`items[fromIndex]` を先に取り出して `undefined` チェックを `isFromValid` と統合すれば分岐は 1 つになる。**

```ts
export function moveItem<TValue>(
  items: readonly TValue[],
  fromIndex: number,
  toIndex: number,
): readonly TValue[] {
  const moved = items[fromIndex];
  // 添字が範囲外なら moved が undefined になる。長さの比較と undefined 判定を 1 つにまとめる
  if (moved === undefined || toIndex < 0 || toIndex >= items.length) {
    return items;
  }
  const rest = items.filter((_, index) => index !== fromIndex);
  return [...rest.slice(0, toIndex), moved, ...rest.slice(toIndex)];
}
```

**後者を採用する。** 前者は `moved === undefined` が到達不能な死に分岐になり、「除外するしかない分岐」を生むためである。

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/mobile -- src/features/owner/move-item.test.ts`
Expected: PASS（8 件）。**`TValue` に `undefined` を含む配列を渡すと早期 return してしまうが、写真・メニュー・クーポンのどれも `undefined` を要素に持たないので問題にならない。この制約は関数の doc コメントに明記する。**

- [ ] **Step 5: `pickShopImage` のテストを書いて実装する**

```ts
// apps/mobile/src/features/owner/pick-image.test.ts
import { describe, expect, it, jest } from '@jest/globals';

import { pickShopImage } from './pick-image';

jest.mock('expo-image-picker');
const mockedPicker = jest.requireMock<typeof import('expo-image-picker')>('expo-image-picker');

describe('pickShopImage', () => {
  it('許可されなければ null を返し、ピッカーを開かない', async () => {
    mockedPicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: false });
    await expect(pickShopImage()).resolves.toBeNull();
    expect(mockedPicker.launchImageLibraryAsync).not.toHaveBeenCalled();
  });

  it('選択をやめたら null を返す', async () => {
    mockedPicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true });
    mockedPicker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });
    await expect(pickShopImage()).resolves.toBeNull();
  });

  it('選んだ画像の uri / mimeType / fileName を返す', async () => {
    mockedPicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true });
    mockedPicker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/a.jpg', mimeType: 'image/jpeg', fileName: 'a.jpg' }],
    });
    await expect(pickShopImage()).resolves.toEqual({
      uri: 'file:///tmp/a.jpg',
      mimeType: 'image/jpeg',
      fileName: 'a.jpg',
    });
  });

  it('assets が空配列なら null を返す（canceled が false でも起こりうる）', async () => {
    mockedPicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true });
    mockedPicker.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [] });
    await expect(pickShopImage()).resolves.toBeNull();
  });
});
```

```ts
// apps/mobile/src/features/owner/pick-image.ts
import * as ImagePicker from 'expo-image-picker';

import type { PhotoUploadSource } from './api';

/**
 * 画像を 1 枚選ばせる。
 * 許可が無い・選択をやめた・0 件だった場合はすべて null を返し、
 * 呼び出し側は「何も起きなかった」として同じ扱いにできる。
 */
export async function pickShopImage(): Promise<PhotoUploadSource | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    return null;
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    // 1 枚ずつ送る。複数選択は「途中で 1 枚だけ失敗した」状態の扱いが要り、MVP には重い
    allowsMultipleSelection: false,
  });
  if (result.canceled) {
    return null;
  }
  const asset = result.assets[0];
  if (asset === undefined) {
    return null;
  }
  return { uri: asset.uri, mimeType: asset.mimeType, fileName: asset.fileName };
}
```

**`mediaTypes` の指定形式は Expo SDK 57 のものを使うこと。`https://docs.expo.dev/versions/v57.0.0/sdk/imagepicker/` を開いて `launchImageLibraryAsync` の引数を確認してから書く。未確認：この計画を書いた時点では、SDK 57 の `mediaTypes` が配列形式（`['images']`）か列挙形式（`MediaTypeOptions.Images`）かを、ドキュメントを開いて確認していない。実装時に必ず開くこと。**

Run: `npm run test -w @meshimap/mobile -- src/features/owner/pick-image.test.ts`
Expected: PASS（4 件）。

- [ ] **Step 6: `PhotoTile` のテストを書いて実装する**

```tsx
// apps/mobile/src/components/owner/photo-tile.test.tsx
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { PhotoTile } from './photo-tile';

const photo = {
  id: 'pht_1',
  url: 'https://example.test/a.jpg',
  caption: '外観',
  sortOrder: 0,
  isCover: false,
};
const handlers = {
  onSetCover: jest.fn(),
  onMoveUp: jest.fn(),
  onMoveDown: jest.fn(),
  onDelete: jest.fn(),
};

describe('PhotoTile', () => {
  it('キャプションを出す', () => {
    render(<PhotoTile photo={photo} canMoveUp canMoveDown {...handlers} testID="tile" />);
    expect(screen.getByText('外観')).toBeTruthy();
  });

  it('カバーなら「カバー」バッジを出す', () => {
    render(
      <PhotoTile
        photo={{ ...photo, isCover: true }}
        canMoveUp
        canMoveDown
        {...handlers}
        testID="tile"
      />,
    );
    expect(screen.getByText('カバー')).toBeTruthy();
  });

  it('カバーでなければ「カバーにする」を押せる', () => {
    render(<PhotoTile photo={photo} canMoveUp canMoveDown {...handlers} testID="tile" />);
    fireEvent.press(screen.getByTestId('tile-set-cover'));
    expect(handlers.onSetCover).toHaveBeenCalledTimes(1);
  });

  it('カバーなら「カバーにする」を出さない（自分をカバーにする操作は意味がない）', () => {
    render(
      <PhotoTile
        photo={{ ...photo, isCover: true }}
        canMoveUp
        canMoveDown
        {...handlers}
        testID="tile"
      />,
    );
    expect(screen.queryByTestId('tile-set-cover')).toBeNull();
  });

  it('先頭の写真は「上へ」が押せない', () => {
    render(<PhotoTile photo={photo} canMoveUp={false} canMoveDown {...handlers} testID="tile" />);
    expect(screen.getByTestId('tile-move-up').props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });

  it('末尾の写真は「下へ」が押せない', () => {
    render(<PhotoTile photo={photo} canMoveUp canMoveDown={false} {...handlers} testID="tile" />);
    expect(screen.getByTestId('tile-move-down').props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });

  it('削除を押すと onDelete が呼ばれる', () => {
    render(<PhotoTile photo={photo} canMoveUp canMoveDown {...handlers} testID="tile" />);
    fireEvent.press(screen.getByTestId('tile-delete'));
    expect(handlers.onDelete).toHaveBeenCalledTimes(1);
  });

  it('キャプションが無ければ「説明なし」と表示する（空白の行にしない）', () => {
    render(
      <PhotoTile
        photo={{ ...photo, caption: null }}
        canMoveUp
        canMoveDown
        {...handlers}
        testID="tile"
      />,
    );
    expect(screen.getByText('説明なし')).toBeTruthy();
  });
});
```

```tsx
// apps/mobile/src/components/owner/photo-tile.tsx
import { Image } from 'expo-image';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import type { ShopPhoto } from '@/features/owner/types';

export interface PhotoTileProps {
  photo: ShopPhoto;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSetCover: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  testID?: string | undefined;
}

/** サムネイルの一辺（px）。1 行に画像＋操作を並べても収まる大きさ */
const THUMBNAIL_SIZE = 72;

const COVER_LABEL = 'カバー';
const SET_COVER_LABEL = 'カバーにする';
const NO_CAPTION_LABEL = '説明なし';

function buildChildTestId(testID: string | undefined, suffix: string): string | undefined {
  return testID === undefined ? undefined : `${testID}-${suffix}`;
}

export function PhotoTile({
  photo,
  canMoveUp,
  canMoveDown,
  onSetCover,
  onMoveUp,
  onMoveDown,
  onDelete,
  testID,
}: PhotoTileProps) {
  return (
    <Card padding="sm" testID={testID}>
      <View className="flex-row items-center gap-3">
        <Image
          source={{ uri: photo.url }}
          style={{ width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE }}
          contentFit="cover"
          accessibilityLabel={photo.caption ?? NO_CAPTION_LABEL}
        />
        <View className="flex-1">
          <Text className="text-sm text-neutral-800">{photo.caption ?? NO_CAPTION_LABEL}</Text>
          {photo.isCover ? (
            <View className="mt-1 flex-row">
              <Badge label={COVER_LABEL} tone="brand" />
            </View>
          ) : (
            <View className="mt-1">
              <Button
                label={SET_COVER_LABEL}
                variant="ghost"
                size="sm"
                onPress={onSetCover}
                testID={buildChildTestId(testID, 'set-cover')}
              />
            </View>
          )}
        </View>
        <Pressable
          accessibilityLabel="上へ移動"
          accessibilityState={{ disabled: !canMoveUp }}
          disabled={!canMoveUp}
          onPress={onMoveUp}
          testID={buildChildTestId(testID, 'move-up')}
        >
          <Icon icon={ChevronUp} size="md" />
        </Pressable>
        <Pressable
          accessibilityLabel="下へ移動"
          accessibilityState={{ disabled: !canMoveDown }}
          disabled={!canMoveDown}
          onPress={onMoveDown}
          testID={buildChildTestId(testID, 'move-down')}
        >
          <Icon icon={ChevronDown} size="md" />
        </Pressable>
        <Pressable
          accessibilityLabel="削除"
          onPress={onDelete}
          testID={buildChildTestId(testID, 'delete')}
        >
          <Icon icon={Trash2} size="md" />
        </Pressable>
      </View>
    </Card>
  );
}
```

Run: `npm run test -w @meshimap/mobile -- src/components/owner/photo-tile.test.tsx`
Expected: PASS（8 件）。

- [ ] **Step 7: 写真画面のテストを書く**

```tsx
// apps/mobile/src/app/(owner)/shop/photos.test.tsx
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { createQueryWrapper } from '@/features/owner/testing/query-wrapper';

import OwnerShopPhotosScreen from './photos';

jest.mock('@/features/owner/api');
jest.mock('@/features/owner/pick-image');
const mockedApi = jest.requireMock<typeof import('@/features/owner/api')>('@/features/owner/api');
const mockedPick = jest.requireMock<typeof import('@/features/owner/pick-image')>(
  '@/features/owner/pick-image',
);
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), push: jest.fn() }) }));

const shop = {
  id: 'shp_1',
  name: 'ラーメン太郎',
  status: 'published',
  ratingAvg: 0,
  ratingCount: 0,
};
const photo = (id: string, sortOrder: number, isCover = false) => ({
  id,
  url: `https://example.test/${id}.jpg`,
  caption: null,
  sortOrder,
  isCover,
});

function renderScreen() {
  const { wrapper: Wrapper } = createQueryWrapper();
  return render(<OwnerShopPhotosScreen />, { wrapper: Wrapper });
}

describe('写真画面', () => {
  it('0 枚なら空状態を出す', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopPhotos.mockResolvedValue([]);
    renderScreen();
    await waitFor(() => expect(screen.getByText('写真がまだありません')).toBeTruthy());
  });

  it('枚数を出す', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopPhotos.mockResolvedValue([photo('pht_1', 0, true), photo('pht_2', 1)]);
    renderScreen();
    await waitFor(() => expect(screen.getByText('2 / 20 枚')).toBeTruthy());
  });

  it('追加を押して画像を選ぶとアップロードする', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopPhotos.mockResolvedValue([]);
    mockedPick.pickShopImage.mockResolvedValue({
      uri: 'file:///tmp/a.jpg',
      mimeType: 'image/jpeg',
      fileName: 'a.jpg',
    });
    mockedApi.uploadShopPhoto.mockResolvedValue(photo('pht_1', 0, true));
    renderScreen();
    await waitFor(() => expect(screen.getByText('写真を追加')).toBeTruthy());
    fireEvent.press(screen.getByText('写真を追加'));
    await waitFor(() => expect(mockedApi.uploadShopPhoto).toHaveBeenCalledTimes(1));
  });

  it('画像選択をやめたらアップロードしない', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopPhotos.mockResolvedValue([]);
    mockedPick.pickShopImage.mockResolvedValue(null);
    renderScreen();
    await waitFor(() => expect(screen.getByText('写真を追加')).toBeTruthy());
    fireEvent.press(screen.getByText('写真を追加'));
    await waitFor(() => expect(mockedPick.pickShopImage).toHaveBeenCalledTimes(1));
    expect(mockedApi.uploadShopPhoto).not.toHaveBeenCalled();
  });

  it('20 枚あると追加ボタンが押せない', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopPhotos.mockResolvedValue(
      Array.from({ length: 20 }, (_, index) => photo(`pht_${index}`, index, index === 0)),
    );
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('photos-add')).toBeTruthy());
    expect(screen.getByTestId('photos-add').props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });

  it('「下へ」を押すと並べ替え後の ID 配列を送る', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopPhotos.mockResolvedValue([photo('pht_1', 0, true), photo('pht_2', 1)]);
    mockedApi.reorderShopPhotos.mockResolvedValue([photo('pht_2', 0, true), photo('pht_1', 1)]);
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('photo-pht_1-move-down')).toBeTruthy());
    fireEvent.press(screen.getByTestId('photo-pht_1-move-down'));
    await waitFor(() =>
      expect(mockedApi.reorderShopPhotos).toHaveBeenCalledWith('shp_1', ['pht_2', 'pht_1']),
    );
  });

  it('「カバーにする」を押すと isCover: true を送る', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopPhotos.mockResolvedValue([photo('pht_1', 0, true), photo('pht_2', 1)]);
    mockedApi.updateShopPhoto.mockResolvedValue(photo('pht_2', 1, true));
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('photo-pht_2-set-cover')).toBeTruthy());
    fireEvent.press(screen.getByTestId('photo-pht_2-set-cover'));
    await waitFor(() =>
      expect(mockedApi.updateShopPhoto).toHaveBeenCalledWith('shp_1', 'pht_2', {
        caption: null,
        isCover: true,
      }),
    );
  });

  it('削除を押すと deleteShopPhoto を呼ぶ', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopPhotos.mockResolvedValue([photo('pht_1', 0, true)]);
    mockedApi.deleteShopPhoto.mockResolvedValue(undefined);
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('photo-pht_1-delete')).toBeTruthy());
    fireEvent.press(screen.getByTestId('photo-pht_1-delete'));
    await waitFor(() => expect(mockedApi.deleteShopPhoto).toHaveBeenCalledWith('shp_1', 'pht_1'));
  });

  it('アップロードに失敗したらエラー文言を出す', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchShopPhotos.mockResolvedValue([]);
    mockedPick.pickShopImage.mockResolvedValue({
      uri: 'file:///tmp/a.jpg',
      mimeType: 'image/jpeg',
      fileName: 'a.jpg',
    });
    mockedApi.uploadShopPhoto.mockRejectedValue(new Error('落ちた'));
    renderScreen();
    await waitFor(() => expect(screen.getByText('写真を追加')).toBeTruthy());
    fireEvent.press(screen.getByText('写真を追加'));
    await waitFor(() =>
      expect(screen.getByText('写真をアップロードできませんでした')).toBeTruthy(),
    );
  });
});
```

- [ ] **Step 8: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/shop/photos.test.tsx'`
Expected: FAIL。`Cannot find module './photos'`。

- [ ] **Step 9: 写真画面を実装する**

```tsx
// apps/mobile/src/app/(owner)/shop/photos.tsx
import { ImageIcon } from 'lucide-react-native';
import { ScrollView, Text, View } from 'react-native';

import { PhotoTile } from '@/components/owner/photo-tile';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { SHOP_PHOTO_MAX_COUNT } from '@/constants/owner';
import { moveItem } from '@/features/owner/move-item';
import { pickShopImage } from '@/features/owner/pick-image';
import {
  useDeleteShopPhoto,
  useReorderShopPhotos,
  useShopPhotos,
  useUpdateShopPhoto,
  useUploadShopPhoto,
} from '@/features/owner/queries';
import { useActiveShop } from '@/features/owner/use-active-shop';

const UPLOAD_ERROR_MESSAGE = '写真をアップロードできませんでした';
const ADD_LABEL = '写真を追加';

export default function OwnerShopPhotosScreen() {
  const activeShop = useActiveShop();
  const shopId = activeShop.shopId;
  const photosQuery = useShopPhotos(shopId);
  const uploadPhoto = useUploadShopPhoto(shopId ?? '');
  const updatePhoto = useUpdateShopPhoto(shopId ?? '');
  const reorderPhotos = useReorderShopPhotos(shopId ?? '');
  const deletePhoto = useDeleteShopPhoto(shopId ?? '');

  if (shopId === null || photosQuery.isLoading) {
    return <Skeleton height={400} testID="photos-skeleton" />;
  }
  if (photosQuery.isError) {
    return (
      <ErrorState
        description="写真を取得できませんでした"
        onRetry={() => void photosQuery.refetch()}
      />
    );
  }

  const photos = photosQuery.data ?? [];
  const isFull = photos.length >= SHOP_PHOTO_MAX_COUNT;

  const onAdd = async () => {
    const source = await pickShopImage();
    // 許可が無い・やめた・0 件はすべて null。何も起きなかったものとして扱う
    if (source === null) {
      return;
    }
    uploadPhoto.mutate(source);
  };

  const onMove = (fromIndex: number, toIndex: number) => {
    const reordered = moveItem(photos, fromIndex, toIndex);
    // 並びが変わらなかったなら送らない（末尾で「下へ」を押したときなど）
    if (reordered === photos) {
      return;
    }
    reorderPhotos.mutate(reordered.map((item) => item.id));
  };

  return (
    <ScrollView contentContainerClassName="gap-3 p-md">
      <Text className="text-sm text-neutral-600">
        {photos.length} / {SHOP_PHOTO_MAX_COUNT} 枚
      </Text>
      <Button
        label={ADD_LABEL}
        onPress={() => void onAdd()}
        isDisabled={isFull}
        isLoading={uploadPhoto.isPending}
        testID="photos-add"
      />
      {uploadPhoto.isError && <Text className="text-sm text-red-500">{UPLOAD_ERROR_MESSAGE}</Text>}

      {photos.length === 0 ? (
        <EmptyState
          icon={ImageIcon}
          title="写真がまだありません"
          description="外観や看板メニューの写真を追加すると、検索結果で目に留まりやすくなります"
        />
      ) : (
        <View className="gap-2">
          {photos.map((item, index) => (
            <PhotoTile
              key={item.id}
              photo={item}
              canMoveUp={index > 0}
              canMoveDown={index < photos.length - 1}
              onSetCover={() =>
                updatePhoto.mutate({ photoId: item.id, caption: item.caption, isCover: true })
              }
              onMoveUp={() => onMove(index, index - 1)}
              onMoveDown={() => onMove(index, index + 1)}
              onDelete={() => deletePhoto.mutate(item.id)}
              testID={`photo-${item.id}`}
            />
          ))}
        </View>
      )}
    </ScrollView>
  );
}
```

- [ ] **Step 10: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/shop/photos.test.tsx'`
Expected: PASS（9 件）。

- [ ] **Step 11: 位置画面のテストを書く**

```tsx
// apps/mobile/src/app/(owner)/shop/location.test.tsx
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { createQueryWrapper } from '@/features/owner/testing/query-wrapper';

import OwnerShopLocationScreen from './location';

jest.mock('@/features/owner/api');
const mockedApi = jest.requireMock<typeof import('@/features/owner/api')>('@/features/owner/api');
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn() }) }));

const shopDetail = {
  id: 'shp_1',
  name: 'ラーメン太郎',
  status: 'published',
  ratingAvg: 0,
  ratingCount: 0,
  lat: 35.681236,
  lng: 139.767125,
  address: '東京都千代田区丸の内1-9-1',
};

function renderScreen() {
  const { wrapper: Wrapper } = createQueryWrapper();
  return render(<OwnerShopLocationScreen />, { wrapper: Wrapper });
}

describe('位置画面', () => {
  it('現在の座標を表示する', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shopDetail]);
    mockedApi.fetchShopLocation.mockResolvedValue({ lat: 35.681236, lng: 139.767125 });
    renderScreen();
    await waitFor(() => expect(screen.getByText('緯度 35.681236 / 経度 139.767125')).toBeTruthy());
  });

  it('ピンをドラッグすると表示座標が変わる', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shopDetail]);
    mockedApi.fetchShopLocation.mockResolvedValue({ lat: 35.681236, lng: 139.767125 });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('location-marker')).toBeTruthy());
    fireEvent(screen.getByTestId('location-marker'), 'dragEnd', {
      nativeEvent: { coordinate: { latitude: 35.7, longitude: 139.8 } },
    });
    expect(screen.getByText('緯度 35.700000 / 経度 139.800000')).toBeTruthy();
  });

  it('ドラッグしただけでは保存しない（誤操作で位置が変わらないようにする）', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shopDetail]);
    mockedApi.fetchShopLocation.mockResolvedValue({ lat: 35.681236, lng: 139.767125 });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('location-marker')).toBeTruthy());
    fireEvent(screen.getByTestId('location-marker'), 'dragEnd', {
      nativeEvent: { coordinate: { latitude: 35.7, longitude: 139.8 } },
    });
    expect(mockedApi.updateShopLocation).not.toHaveBeenCalled();
  });

  it('保存を押すとドラッグ後の座標を送る', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shopDetail]);
    mockedApi.fetchShopLocation.mockResolvedValue({ lat: 35.681236, lng: 139.767125 });
    mockedApi.updateShopLocation.mockResolvedValue({ lat: 35.7, lng: 139.8 });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('location-marker')).toBeTruthy());
    fireEvent(screen.getByTestId('location-marker'), 'dragEnd', {
      nativeEvent: { coordinate: { latitude: 35.7, longitude: 139.8 } },
    });
    fireEvent.press(screen.getByText('この位置で保存'));
    await waitFor(() =>
      expect(mockedApi.updateShopLocation).toHaveBeenCalledWith('shp_1', { lat: 35.7, lng: 139.8 }),
    );
  });

  it('geohash はクライアントから送らない（サーバが導出する）', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shopDetail]);
    mockedApi.fetchShopLocation.mockResolvedValue({ lat: 35.681236, lng: 139.767125 });
    mockedApi.updateShopLocation.mockResolvedValue({ lat: 35.681236, lng: 139.767125 });
    renderScreen();
    await waitFor(() => expect(screen.getByText('この位置で保存')).toBeTruthy());
    fireEvent.press(screen.getByText('この位置で保存'));
    await waitFor(() => expect(mockedApi.updateShopLocation).toHaveBeenCalledTimes(1));
    expect(Object.keys(mockedApi.updateShopLocation.mock.calls[0]?.[1] ?? {})).toEqual([
      'lat',
      'lng',
    ]);
  });

  it('元に戻すを押すと取得時の座標に戻る', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shopDetail]);
    mockedApi.fetchShopLocation.mockResolvedValue({ lat: 35.681236, lng: 139.767125 });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('location-marker')).toBeTruthy());
    fireEvent(screen.getByTestId('location-marker'), 'dragEnd', {
      nativeEvent: { coordinate: { latitude: 35.7, longitude: 139.8 } },
    });
    fireEvent.press(screen.getByText('元に戻す'));
    expect(screen.getByText('緯度 35.681236 / 経度 139.767125')).toBeTruthy();
  });

  it('保存に失敗したらエラー文言を出し、ドラッグ後の座標は保持する', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shopDetail]);
    mockedApi.fetchShopLocation.mockResolvedValue({ lat: 35.681236, lng: 139.767125 });
    mockedApi.updateShopLocation.mockRejectedValue(new Error('落ちた'));
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('location-marker')).toBeTruthy());
    fireEvent(screen.getByTestId('location-marker'), 'dragEnd', {
      nativeEvent: { coordinate: { latitude: 35.7, longitude: 139.8 } },
    });
    fireEvent.press(screen.getByText('この位置で保存'));
    await waitFor(() => expect(screen.getByText('保存できませんでした')).toBeTruthy());
    expect(screen.getByText('緯度 35.700000 / 経度 139.800000')).toBeTruthy();
  });
});
```

- [ ] **Step 12: 位置画面と対応する API 関数を実装する**

`features/owner/api.ts` に 2 本足す。

```ts
const shopLocationSchema = z.object({ lat: z.number(), lng: z.number() });
export type ShopLocation = z.infer<typeof shopLocationSchema>;

export function fetchShopLocation(shopId: string): Promise<ShopLocation> {
  return request(`/owner/shops/${encodeSegment(shopId)}/location`, shopLocationSchema);
}

/**
 * 緯度経度だけを送る。geohash は送らない。
 * 導出値をクライアントが計算して送ると、古いアプリが古い精度の値を送ってきたときに
 * 近傍検索の結果だけが静かにおかしくなる。
 */
export function updateShopLocation(shopId: string, input: ShopLocation): Promise<ShopLocation> {
  return request(`/shops/${encodeSegment(shopId)}`, shopLocationSchema, jsonInit('PATCH', input));
}
```

**`GET /owner/shops/:shopId/location` は Task 8-13 の `shop-routes.ts` に実装済みの想定である**（`findOwnedShopLocation` を呼んで `lat` / `lng` だけを返す 3 行のハンドラ、権限マトリクス #16）。この画面の実装に入る前に、`apps/api/src/routes/owner/shop-routes.ts` にそのハンドラがあることを確認すること。無ければ Task 8-13 の実装漏れなので、先にそちらを直す。

```tsx
// apps/mobile/src/app/(owner)/shop/location.tsx
import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useShopLocation, useUpdateShopLocation } from '@/features/owner/queries';
import type { ShopLocation } from '@/features/owner/api';
import { useActiveShop } from '@/features/owner/use-active-shop';

/** 座標の表示桁。地図のピンは 6 桁（約 0.1m）あれば十分 */
const COORDINATE_FRACTION_DIGITS = 6;

/** 地図の初期表示範囲（度）。店舗周辺が見える程度に寄せる */
const MAP_DELTA = 0.005;

/** 地図の高さ（px）。画面の半分程度を占める */
const MAP_HEIGHT = 320;

const SAVE_ERROR_MESSAGE = '保存できませんでした';

function formatCoordinates(location: ShopLocation): string {
  return `緯度 ${location.lat.toFixed(COORDINATE_FRACTION_DIGITS)} / 経度 ${location.lng.toFixed(COORDINATE_FRACTION_DIGITS)}`;
}

export default function OwnerShopLocationScreen() {
  const activeShop = useActiveShop();
  const shopId = activeShop.shopId;
  const locationQuery = useShopLocation(shopId);
  const updateLocation = useUpdateShopLocation(shopId ?? '');
  const [draft, setDraft] = useState<ShopLocation | null>(null);

  // 取得できた時点で下書きを初期化する。以降はドラッグで上書きされる
  useEffect(() => {
    if (locationQuery.data !== undefined) {
      setDraft(locationQuery.data);
    }
  }, [locationQuery.data]);

  if (shopId === null || draft === null) {
    return <Skeleton height={MAP_HEIGHT} testID="location-skeleton" />;
  }
  if (locationQuery.isError) {
    return (
      <ErrorState
        description="位置情報を取得できませんでした"
        onRetry={() => void locationQuery.refetch()}
      />
    );
  }

  return (
    <ScrollView contentContainerClassName="gap-3 p-md">
      <MapView
        style={{ height: MAP_HEIGHT }}
        initialRegion={{
          latitude: draft.lat,
          longitude: draft.lng,
          latitudeDelta: MAP_DELTA,
          longitudeDelta: MAP_DELTA,
        }}
        testID="location-map"
      >
        <Marker
          draggable
          coordinate={{ latitude: draft.lat, longitude: draft.lng }}
          // ドラッグ終了時点では保存しない。誤操作で店の場所が変わるのを防ぐ
          onDragEnd={(event) =>
            setDraft({
              lat: event.nativeEvent.coordinate.latitude,
              lng: event.nativeEvent.coordinate.longitude,
            })
          }
          testID="location-marker"
        />
      </MapView>
      <Card>
        <Text className="text-sm text-neutral-800">{formatCoordinates(draft)}</Text>
      </Card>
      <Button
        label="この位置で保存"
        onPress={() => updateLocation.mutate(draft)}
        isLoading={updateLocation.isPending}
      />
      <Button
        label="元に戻す"
        variant="outline"
        onPress={() => setDraft(locationQuery.data ?? draft)}
      />
      {updateLocation.isError && <Text className="text-sm text-red-500">{SAVE_ERROR_MESSAGE}</Text>}
      <View className="pb-4" />
    </ScrollView>
  );
}
```

**`react-native-maps` は `jest-expo` でそのままレンダリングできないことがある。落ちる場合は `jest.setup.ts` に `jest.mock('react-native-maps', ...)` を置き、`MapView` / `Marker` を `View` に差し替える。未確認：このリポジトリで `react-native-maps` を Jest 環境で描画した実績はまだ無い（Phase 6 が地図画面を作るので、先に実績があればそのモックを再利用する）。**

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/shop/location.test.tsx'`
Expected: PASS（7 件）。

- [ ] **Step 13: わざと壊して検証が効いていることを確認する**

`location.tsx` の `onDragEnd` を `setDraft(...)` ではなく `updateLocation.mutate(...)` に変える（ドラッグで即保存する）。
Expected: FAIL。「ドラッグしただけでは保存しない」が落ちる。

次に `updateShopLocation` の本文に `geohash` を足して送る（`jsonInit('PATCH', { ...input, geohash: 'xn774c' })`）。
Expected: FAIL。「geohash はクライアントから送らない」が落ちる（キーが 3 つになる）。

次に `photos.tsx` の `if (reordered === photos) return;` を消す。
Expected: PASS のまま落ちない。**これは検出できない変異なので、`photos.test.tsx` に「末尾の写真の『下へ』は押せず、`reorderShopPhotos` を呼ばない」テストを 1 件足して殺す。** `canMoveDown={false}` の `Pressable` は `disabled` なので `fireEvent.press` では発火しないが、`moveItem` が範囲外を無視することと合わせて、**「`reorderShopPhotos` が呼ばれない」ことを直接確かめるテストを書く**。

次に `photos.tsx` の `isFull` を `false` 固定にする。
Expected: FAIL。「20 枚あると追加ボタンが押せない」が落ちる。

**4 つとも確認したら元に戻し、追加テストを含めて緑になることを確認する。**

- [ ] **Step 14: カバレッジ・型・lint を通してコミット**

Run: `npm run test -w @meshimap/mobile && npm run typecheck -w @meshimap/mobile && npm run lint`
Expected: すべて成功、カバレッジ 100%。

```bash
git add 'apps/mobile/src/app/(owner)/shop' apps/mobile/src/components/owner apps/mobile/src/features/owner apps/api/src/routes/owner
git commit -m "feat(mobile): 位置ピンドラッグと写真管理を追加"
```

---

## Task 8-20: メニュー一覧と編集

**Files:**

- Create: `apps/mobile/src/components/owner/menu-item-row.tsx`
- Create: `apps/mobile/src/components/owner/menu-item-row.test.tsx`
- Create: `apps/mobile/src/app/(owner)/shop/menu/index.tsx`
- Create: `apps/mobile/src/app/(owner)/shop/menu/index.test.tsx`
- Create: `apps/mobile/src/app/(owner)/shop/menu/[menuItemId].tsx`
- Create: `apps/mobile/src/app/(owner)/shop/menu/[menuItemId].test.tsx`

**Interfaces:**

- Consumes: `useMenuTree` / `useCreateMenuCategory` / `useDeleteMenuCategory` / `useCreateMenuItem` / `useUpdateMenuItem` / `useDeleteMenuItem`（8-15）、`menuItemInputSchema` / `MENU_ITEM_NAME_MAX`（Task 8-3、`@meshimap/core`）、`NEW_ENTITY_ROUTE_SEGMENT`（8-15）、`useLocalSearchParams` / `useRouter`（expo-router）、`Badge` / `Button` / `Card` / `EmptyState` / `ErrorState` / `Icon` / `Input` / `Skeleton`
- Produces:
  - `MenuItemRow({ item, onPress, testID }: MenuItemRowProps)`
  - `formatPriceYen(priceYen: number): string`（`components/owner/menu-item-row.ts` ではなく `src/lib/format-price.ts` に置く。価格表示は Phase 6 の店舗詳細でも使うため）
  - 2 画面（`menu/index` / `menu/[menuItemId]`）

### 1 つの動的ルートで新規と編集を兼ねる

`menu/new.tsx` と `menu/[menuItemId].tsx` を別ファイルにすると、フォームの定義・検証・エラー表示が二重になる。**`[menuItemId]` が `'new'` のときを新規とみなす**ことで、フォームは 1 つで済む。

expo-router は静的セグメント（`new.tsx`）を動的セグメント（`[menuItemId].tsx`）より優先してマッチするので、**`new.tsx` を作らない限り `/shop/menu/new` は `[menuItemId].tsx` に届く。** 判定は `NEW_ENTITY_ROUTE_SEGMENT` 定数 1 箇所でやる。

この形の弱点は「`new` という ID のメニュー項目を作れない」ことだが、ID は `mni_` + 32 桁の 16 進数（Task 8-13 の `buildEntityId`）なので衝突しない。

- [ ] **Step 1: `formatPriceYen` と `MenuItemRow` のテストを書く**

```ts
// apps/mobile/src/lib/format-price.test.ts
import { describe, expect, it } from '@jest/globals';

import { formatPriceYen } from './format-price';

describe('formatPriceYen', () => {
  it('3 桁区切りと円記号を付ける', () => {
    expect(formatPriceYen(1200)).toBe('¥1,200');
  });

  it('0 円は ¥0 と表示する（無料と書かない）', () => {
    expect(formatPriceYen(0)).toBe('¥0');
  });

  it('1000 未満は区切りを入れない', () => {
    expect(formatPriceYen(980)).toBe('¥980');
  });

  it('10 万円台も区切る', () => {
    expect(formatPriceYen(120000)).toBe('¥120,000');
  });
});
```

```tsx
// apps/mobile/src/components/owner/menu-item-row.test.tsx
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { MenuItemRow } from './menu-item-row';

const item = {
  id: 'mni_1',
  categoryId: 'mnc_1',
  name: '醤油ラーメン',
  description: '鶏ガラベース',
  priceYen: 900,
  isRecommended: false,
  sortOrder: 0,
};

describe('MenuItemRow', () => {
  it('名前・説明・価格を出す', () => {
    render(<MenuItemRow item={item} onPress={jest.fn()} testID="row" />);
    expect(screen.getByText('醤油ラーメン')).toBeTruthy();
    expect(screen.getByText('鶏ガラベース')).toBeTruthy();
    expect(screen.getByText('¥900')).toBeTruthy();
  });

  it('おすすめならバッジを出す', () => {
    render(
      <MenuItemRow item={{ ...item, isRecommended: true }} onPress={jest.fn()} testID="row" />,
    );
    expect(screen.getByText('おすすめ')).toBeTruthy();
  });

  it('おすすめでなければバッジを出さない', () => {
    render(<MenuItemRow item={item} onPress={jest.fn()} testID="row" />);
    expect(screen.queryByText('おすすめ')).toBeNull();
  });

  it('説明が無ければ説明の行を出さない', () => {
    render(<MenuItemRow item={{ ...item, description: null }} onPress={jest.fn()} testID="row" />);
    expect(screen.queryByText('鶏ガラベース')).toBeNull();
  });

  it('押すと onPress が呼ばれる', () => {
    const onPress = jest.fn();
    render(<MenuItemRow item={item} onPress={onPress} testID="row" />);
    fireEvent.press(screen.getByTestId('row'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認し、実装する**

Run: `npm run test -w @meshimap/mobile -- src/lib/format-price.test.ts src/components/owner/menu-item-row.test.tsx`
Expected: FAIL（両方 `Cannot find module`）。

```ts
// apps/mobile/src/lib/format-price.ts
/** 通貨記号。日本円のみを扱うので定数で固定する */
const YEN_SIGN = '¥';

/** 3 桁区切りのロケール。ja-JP 固定にして端末設定で表示が変わらないようにする */
const PRICE_LOCALE = 'ja-JP';

/** 円価格を「¥1,200」の形にする。0 円も「無料」ではなく ¥0 と出す（0 円の商品と未設定を混同させない） */
export function formatPriceYen(priceYen: number): string {
  return `${YEN_SIGN}${priceYen.toLocaleString(PRICE_LOCALE)}`;
}
```

```tsx
// apps/mobile/src/components/owner/menu-item-row.tsx
import { Text, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { MenuItem } from '@/features/owner/types';
import { formatPriceYen } from '@/lib/format-price';

export interface MenuItemRowProps {
  item: MenuItem;
  onPress: () => void;
  testID?: string | undefined;
}

const RECOMMENDED_LABEL = 'おすすめ';

export function MenuItemRow({ item, onPress, testID }: MenuItemRowProps) {
  return (
    <Card onPress={onPress} padding="sm" testID={testID}>
      <View className="flex-row items-center justify-between">
        <View className="flex-1">
          <View className="flex-row items-center gap-2">
            <Text className="text-base text-neutral-900">{item.name}</Text>
            {item.isRecommended && <Badge label={RECOMMENDED_LABEL} tone="brand" />}
          </View>
          {/* 説明が無いときに空行を作らない */}
          {item.description !== null && (
            <Text className="mt-1 text-sm text-neutral-600">{item.description}</Text>
          )}
        </View>
        <Text className="text-base font-semibold text-neutral-900">
          {formatPriceYen(item.priceYen)}
        </Text>
      </View>
    </Card>
  );
}
```

Run: `npm run test -w @meshimap/mobile -- src/lib/format-price.test.ts src/components/owner/menu-item-row.test.tsx`
Expected: PASS（9 件）。

- [ ] **Step 3: メニュー一覧のテストを書く**

```tsx
// apps/mobile/src/app/(owner)/shop/menu/index.test.tsx
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { createQueryWrapper } from '@/features/owner/testing/query-wrapper';

import OwnerMenuListScreen from './index';

jest.mock('@/features/owner/api');
const mockedApi = jest.requireMock<typeof import('@/features/owner/api')>('@/features/owner/api');
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const shop = {
  id: 'shp_1',
  name: 'ラーメン太郎',
  status: 'published',
  ratingAvg: 0,
  ratingCount: 0,
};
const item = {
  id: 'mni_1',
  categoryId: 'mnc_1',
  name: '醤油ラーメン',
  description: null,
  priceYen: 900,
  isRecommended: false,
  sortOrder: 0,
};

function renderScreen() {
  const { wrapper: Wrapper } = createQueryWrapper();
  return render(<OwnerMenuListScreen />, { wrapper: Wrapper });
}

describe('メニュー一覧', () => {
  it('カテゴリが無ければ空状態を出す', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchMenuTree.mockResolvedValue({ categories: [] });
    renderScreen();
    await waitFor(() => expect(screen.getByText('カテゴリがまだありません')).toBeTruthy());
  });

  it('カテゴリと項目を入れ子で出す', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchMenuTree.mockResolvedValue({
      categories: [{ id: 'mnc_1', name: 'ランチ', sortOrder: 0, items: [item] }],
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText('ランチ')).toBeTruthy());
    expect(screen.getByText('醤油ラーメン')).toBeTruthy();
  });

  it('項目が 0 件のカテゴリには「まだ登録がありません」を出す', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchMenuTree.mockResolvedValue({
      categories: [{ id: 'mnc_1', name: 'ランチ', sortOrder: 0, items: [] }],
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText('まだ登録がありません')).toBeTruthy());
  });

  it('カテゴリ名を入れて追加すると createMenuCategory を呼ぶ', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchMenuTree.mockResolvedValue({ categories: [] });
    mockedApi.createMenuCategory.mockResolvedValue({ id: 'mnc_2', name: 'ディナー' });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('category-name')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('category-name'), 'ディナー');
    fireEvent.press(screen.getByText('カテゴリを追加'));
    await waitFor(() =>
      expect(mockedApi.createMenuCategory).toHaveBeenCalledWith('shp_1', 'ディナー'),
    );
  });

  it('カテゴリ名が空なら追加できない', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchMenuTree.mockResolvedValue({ categories: [] });
    renderScreen();
    await waitFor(() => expect(screen.getByText('カテゴリを追加')).toBeTruthy());
    fireEvent.press(screen.getByText('カテゴリを追加'));
    await waitFor(() => expect(screen.getByText('カテゴリ名を入力してください')).toBeTruthy());
    expect(mockedApi.createMenuCategory).not.toHaveBeenCalled();
  });

  it('カテゴリ削除は配下の項目も消えることを文言で知らせる', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchMenuTree.mockResolvedValue({
      categories: [{ id: 'mnc_1', name: 'ランチ', sortOrder: 0, items: [item] }],
    });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('category-delete-mnc_1')).toBeTruthy());
    expect(screen.getByTestId('category-delete-mnc_1').props.accessibilityLabel).toBe(
      'ランチを削除。配下の 1 品も削除されます',
    );
  });

  it('項目を押すと編集画面へ遷移する', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchMenuTree.mockResolvedValue({
      categories: [{ id: 'mnc_1', name: 'ランチ', sortOrder: 0, items: [item] }],
    });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('menu-item-mni_1')).toBeTruthy());
    fireEvent.press(screen.getByTestId('menu-item-mni_1'));
    expect(mockPush).toHaveBeenCalledWith('/shop/menu/mni_1');
  });

  it('「メニューを追加」は new へ遷移する', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchMenuTree.mockResolvedValue({
      categories: [{ id: 'mnc_1', name: 'ランチ', sortOrder: 0, items: [] }],
    });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('menu-add-mnc_1')).toBeTruthy());
    fireEvent.press(screen.getByTestId('menu-add-mnc_1'));
    expect(mockPush).toHaveBeenCalledWith('/shop/menu/new?categoryId=mnc_1');
  });
});
```

- [ ] **Step 4: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/shop/menu/index.test.tsx'`
Expected: FAIL。`Cannot find module './index'`。

- [ ] **Step 5: メニュー一覧を実装する**

```tsx
// apps/mobile/src/app/(owner)/shop/menu/index.tsx
import { useRouter } from 'expo-router';
import { Trash2, UtensilsCrossed } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { MenuItemRow } from '@/components/owner/menu-item-row';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { NEW_ENTITY_ROUTE_SEGMENT } from '@/constants/owner';
import {
  useCreateMenuCategory,
  useDeleteMenuCategory,
  useMenuTree,
} from '@/features/owner/queries';
import { useActiveShop } from '@/features/owner/use-active-shop';

const MENU_ROUTE_PREFIX = '/shop/menu';
const CATEGORY_NAME_REQUIRED_MESSAGE = 'カテゴリ名を入力してください';
const EMPTY_CATEGORY_MESSAGE = 'まだ登録がありません';

export default function OwnerMenuListScreen() {
  const router = useRouter();
  const activeShop = useActiveShop();
  const shopId = activeShop.shopId;
  const menuQuery = useMenuTree(shopId);
  const createCategory = useCreateMenuCategory(shopId ?? '');
  const deleteCategory = useDeleteMenuCategory(shopId ?? '');
  const [categoryName, setCategoryName] = useState('');
  const [categoryError, setCategoryError] = useState<string | null>(null);

  if (shopId === null || menuQuery.isLoading) {
    return <Skeleton height={400} testID="menu-skeleton" />;
  }
  if (menuQuery.isError) {
    return (
      <ErrorState
        description="メニューを取得できませんでした"
        onRetry={() => void menuQuery.refetch()}
      />
    );
  }

  const categories = menuQuery.data?.categories ?? [];

  const onAddCategory = () => {
    if (categoryName === '') {
      setCategoryError(CATEGORY_NAME_REQUIRED_MESSAGE);
      return;
    }
    setCategoryError(null);
    createCategory.mutate(categoryName);
    setCategoryName('');
  };

  return (
    <ScrollView contentContainerClassName="gap-3 p-md">
      {categories.length === 0 ? (
        <EmptyState
          icon={UtensilsCrossed}
          title="カテゴリがまだありません"
          description="「ランチ」「ドリンク」などのカテゴリを作ってからメニューを登録します"
        />
      ) : (
        categories.map((category) => (
          <Card key={category.id} testID={`category-${category.id}`}>
            <View className="mb-2 flex-row items-center justify-between">
              <Text className="text-base font-semibold text-neutral-900">{category.name}</Text>
              <Pressable
                // 消えるのが 1 品なのか 20 品なのかで判断が変わる。件数を読み上げに載せる
                accessibilityLabel={`${category.name}を削除。配下の ${category.items.length} 品も削除されます`}
                onPress={() => deleteCategory.mutate(category.id)}
                testID={`category-delete-${category.id}`}
              >
                <Icon icon={Trash2} size="md" />
              </Pressable>
            </View>
            {category.items.length === 0 ? (
              <Text className="text-sm text-neutral-500">{EMPTY_CATEGORY_MESSAGE}</Text>
            ) : (
              <View className="gap-2">
                {category.items.map((item) => (
                  <MenuItemRow
                    key={item.id}
                    item={item}
                    onPress={() => router.push(`${MENU_ROUTE_PREFIX}/${item.id}`)}
                    testID={`menu-item-${item.id}`}
                  />
                ))}
              </View>
            )}
            <View className="mt-2">
              <Button
                label="メニューを追加"
                variant="secondary"
                size="sm"
                onPress={() =>
                  router.push(
                    `${MENU_ROUTE_PREFIX}/${NEW_ENTITY_ROUTE_SEGMENT}?categoryId=${category.id}`,
                  )
                }
                testID={`menu-add-${category.id}`}
              />
            </View>
          </Card>
        ))
      )}

      <Card testID="category-form">
        <Input
          label="カテゴリ名"
          value={categoryName}
          onChangeText={setCategoryName}
          placeholder="ランチ"
          errorMessage={categoryError ?? undefined}
          testID="category-name"
        />
        <Button
          label="カテゴリを追加"
          variant="secondary"
          onPress={onAddCategory}
          isLoading={createCategory.isPending}
        />
      </Card>
    </ScrollView>
  );
}
```

- [ ] **Step 6: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/shop/menu/index.test.tsx'`
Expected: PASS（8 件）。

- [ ] **Step 7: メニュー編集のテストを書く**

```tsx
// apps/mobile/src/app/(owner)/shop/menu/[menuItemId].test.tsx
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { createQueryWrapper } from '@/features/owner/testing/query-wrapper';

import OwnerMenuEditScreen from './[menuItemId]';

jest.mock('@/features/owner/api');
const mockedApi = jest.requireMock<typeof import('@/features/owner/api')>('@/features/owner/api');

const mockBack = jest.fn();
let searchParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack }),
  useLocalSearchParams: () => searchParams,
}));

const shop = {
  id: 'shp_1',
  name: 'ラーメン太郎',
  status: 'published',
  ratingAvg: 0,
  ratingCount: 0,
};
const item = {
  id: 'mni_1',
  categoryId: 'mnc_1',
  name: '醤油ラーメン',
  description: '鶏ガラベース',
  priceYen: 900,
  isRecommended: false,
  sortOrder: 0,
};

function renderScreen() {
  const { wrapper: Wrapper } = createQueryWrapper();
  return render(<OwnerMenuEditScreen />, { wrapper: Wrapper });
}

describe('メニュー編集（新規）', () => {
  it('menuItemId が new なら空のフォームを出す', async () => {
    searchParams = { menuItemId: 'new', categoryId: 'mnc_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchMenuTree.mockResolvedValue({
      categories: [{ id: 'mnc_1', name: 'ランチ', sortOrder: 0, items: [] }],
    });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('menu-name')).toBeTruthy());
    expect(screen.getByTestId('menu-name').props.value).toBe('');
  });

  it('新規なら削除ボタンを出さない', async () => {
    searchParams = { menuItemId: 'new', categoryId: 'mnc_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchMenuTree.mockResolvedValue({
      categories: [{ id: 'mnc_1', name: 'ランチ', sortOrder: 0, items: [] }],
    });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('menu-name')).toBeTruthy());
    expect(screen.queryByText('削除')).toBeNull();
  });

  it('保存すると createMenuItem を呼び、前の画面に戻る', async () => {
    searchParams = { menuItemId: 'new', categoryId: 'mnc_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchMenuTree.mockResolvedValue({
      categories: [{ id: 'mnc_1', name: 'ランチ', sortOrder: 0, items: [] }],
    });
    mockedApi.createMenuItem.mockResolvedValue(item);
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('menu-name')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('menu-name'), '塩ラーメン');
    fireEvent.changeText(screen.getByTestId('menu-price'), '850');
    fireEvent.press(screen.getByText('保存'));
    await waitFor(() => expect(mockedApi.createMenuItem).toHaveBeenCalledTimes(1));
    expect(mockedApi.createMenuItem.mock.calls[0]?.[1]).toMatchObject({
      name: '塩ラーメン',
      priceYen: 850,
    });
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  });
});

describe('メニュー編集（既存）', () => {
  it('既存の値がフォームに入る', async () => {
    searchParams = { menuItemId: 'mni_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchMenuTree.mockResolvedValue({
      categories: [{ id: 'mnc_1', name: 'ランチ', sortOrder: 0, items: [item] }],
    });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('menu-name').props.value).toBe('醤油ラーメン'));
    expect(screen.getByTestId('menu-price').props.value).toBe('900');
  });

  it('名前を空にすると保存できずエラー文言を出す', async () => {
    searchParams = { menuItemId: 'mni_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchMenuTree.mockResolvedValue({
      categories: [{ id: 'mnc_1', name: 'ランチ', sortOrder: 0, items: [item] }],
    });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('menu-name')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('menu-name'), '');
    fireEvent.press(screen.getByText('保存'));
    await waitFor(() => expect(screen.getByText('メニュー名を入力してください')).toBeTruthy());
    expect(mockedApi.updateMenuItem).not.toHaveBeenCalled();
  });

  it('価格が負なら保存できない', async () => {
    searchParams = { menuItemId: 'mni_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchMenuTree.mockResolvedValue({
      categories: [{ id: 'mnc_1', name: 'ランチ', sortOrder: 0, items: [item] }],
    });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('menu-price')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('menu-price'), '-1');
    fireEvent.press(screen.getByText('保存'));
    await waitFor(() => expect(screen.getByText('0 以上で入力してください')).toBeTruthy());
    expect(mockedApi.updateMenuItem).not.toHaveBeenCalled();
  });

  it('価格 0 は保存できる（無料メニューがありうる）', async () => {
    searchParams = { menuItemId: 'mni_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchMenuTree.mockResolvedValue({
      categories: [{ id: 'mnc_1', name: 'ランチ', sortOrder: 0, items: [item] }],
    });
    mockedApi.updateMenuItem.mockResolvedValue({ ...item, priceYen: 0 });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('menu-price')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('menu-price'), '0');
    fireEvent.press(screen.getByText('保存'));
    await waitFor(() => expect(mockedApi.updateMenuItem).toHaveBeenCalledTimes(1));
  });

  it('削除を押すと deleteMenuItem を呼び、前の画面に戻る', async () => {
    searchParams = { menuItemId: 'mni_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchMenuTree.mockResolvedValue({
      categories: [{ id: 'mnc_1', name: 'ランチ', sortOrder: 0, items: [item] }],
    });
    mockedApi.deleteMenuItem.mockResolvedValue(undefined);
    renderScreen();
    await waitFor(() => expect(screen.getByText('削除')).toBeTruthy());
    fireEvent.press(screen.getByText('削除'));
    await waitFor(() => expect(mockedApi.deleteMenuItem).toHaveBeenCalledWith('shp_1', 'mni_1'));
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
  });

  it('存在しない menuItemId なら「見つかりません」を出す', async () => {
    searchParams = { menuItemId: 'mni_nope' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchMenuTree.mockResolvedValue({
      categories: [{ id: 'mnc_1', name: 'ランチ', sortOrder: 0, items: [item] }],
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText('メニューが見つかりません')).toBeTruthy());
  });
});
```

- [ ] **Step 8: メニュー編集を実装する**

```tsx
// apps/mobile/src/app/(owner)/shop/menu/[menuItemId].tsx
import { zodResolver } from '@hookform/resolvers/zod';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { UtensilsCrossed } from 'lucide-react-native';
import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { ScrollView, Switch, Text, View } from 'react-native';
import { menuItemInputSchema } from '@meshimap/core';
import type { MenuItemInput } from '@meshimap/core';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { MENU_ITEM_NAME_MAX } from '@meshimap/core';

import { NEW_ENTITY_ROUTE_SEGMENT } from '@/constants/owner';
import {
  useCreateMenuItem,
  useDeleteMenuItem,
  useMenuTree,
  useUpdateMenuItem,
} from '@/features/owner/queries';
import { useActiveShop } from '@/features/owner/use-active-shop';

/** 価格入力は文字列で受けるので、数値化の失敗を 0 に丸めず NaN のまま Zod に渡して弾かせる */
function toPriceNumber(raw: string): number {
  return raw === '' ? Number.NaN : Number(raw);
}

export default function OwnerMenuEditScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ menuItemId: string; categoryId?: string }>();
  const activeShop = useActiveShop();
  const shopId = activeShop.shopId;
  const menuQuery = useMenuTree(shopId);
  const createItem = useCreateMenuItem(shopId ?? '');
  const updateItem = useUpdateMenuItem(shopId ?? '');
  const deleteItem = useDeleteMenuItem(shopId ?? '');

  const isNew = params.menuItemId === NEW_ENTITY_ROUTE_SEGMENT;
  const existingItem = (menuQuery.data?.categories ?? [])
    .flatMap((category) => category.items)
    .find((item) => item.id === params.menuItemId);

  const form = useForm<MenuItemInput>({
    resolver: zodResolver(menuItemInputSchema),
    defaultValues: {
      categoryId: params.categoryId ?? null,
      name: '',
      description: null,
      priceYen: Number.NaN,
      isRecommended: false,
      // 並び順は画面から編集しない。新規は末尾に積む意味で 0 を送り、サーバ側では
      // createMenuItemAsOwner が同カテゴリの最大値 + 1 に置き換える（Task 8-9）
      sortOrder: 0,
    },
  });
  const { reset } = form;

  useEffect(() => {
    if (existingItem !== undefined) {
      reset({
        categoryId: existingItem.categoryId,
        name: existingItem.name,
        description: existingItem.description,
        priceYen: existingItem.priceYen,
        isRecommended: existingItem.isRecommended,
        sortOrder: existingItem.sortOrder,
      });
    }
  }, [existingItem, reset]);

  if (shopId === null || menuQuery.isLoading) {
    return <Skeleton height={320} testID="menu-edit-skeleton" />;
  }
  if (menuQuery.isError) {
    return (
      <ErrorState
        description="メニューを取得できませんでした"
        onRetry={() => void menuQuery.refetch()}
      />
    );
  }
  // 新規でないのに見つからない = 他端末で消された、URL を直打ちされた
  if (!isNew && existingItem === undefined) {
    return (
      <EmptyState
        icon={UtensilsCrossed}
        title="メニューが見つかりません"
        description="他の端末で削除された可能性があります"
        action={{ label: '一覧に戻る', onPress: () => router.back() }}
      />
    );
  }

  const onSubmit = form.handleSubmit((values) => {
    const onSuccess = () => router.back();
    if (isNew) {
      createItem.mutate(values, { onSuccess });
      return;
    }
    updateItem.mutate({ menuItemId: params.menuItemId, input: values }, { onSuccess });
  });

  return (
    <ScrollView contentContainerClassName="gap-3 p-md">
      <Controller
        control={form.control}
        name="name"
        render={({ field, fieldState }) => (
          <Input
            label="メニュー名"
            value={field.value}
            onChangeText={field.onChange}
            isRequired
            maxLength={MENU_ITEM_NAME_MAX}
            errorMessage={fieldState.error?.message}
            testID="menu-name"
          />
        )}
      />
      <Controller
        control={form.control}
        name="priceYen"
        render={({ field, fieldState }) => (
          <Input
            label="価格（円）"
            value={Number.isNaN(field.value) ? '' : String(field.value)}
            onChangeText={(text) => field.onChange(toPriceNumber(text))}
            isRequired
            errorMessage={fieldState.error?.message}
            testID="menu-price"
          />
        )}
      />
      <Controller
        control={form.control}
        name="description"
        render={({ field, fieldState }) => (
          <Input
            label="説明"
            value={field.value ?? ''}
            onChangeText={(text) => field.onChange(text === '' ? null : text)}
            isMultiline
            errorMessage={fieldState.error?.message}
            testID="menu-description"
          />
        )}
      />
      <Controller
        control={form.control}
        name="isRecommended"
        render={({ field }) => (
          <View className="flex-row items-center justify-between">
            <Text className="text-base text-neutral-900">おすすめとして表示する</Text>
            <Switch value={field.value} onValueChange={field.onChange} testID="menu-recommended" />
          </View>
        )}
      />
      <Button
        label="保存"
        onPress={onSubmit}
        isLoading={createItem.isPending || updateItem.isPending}
      />
      {/* 新規に削除ボタンを出すと「まだ無いものを消す」操作になる */}
      {!isNew && (
        <Button
          label="削除"
          variant="danger"
          onPress={() => deleteItem.mutate(params.menuItemId, { onSuccess: () => router.back() })}
          isLoading={deleteItem.isPending}
        />
      )}
    </ScrollView>
  );
}
```

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/shop/menu/[menuItemId].test.tsx'`
Expected: PASS（9 件）。

- [ ] **Step 9: わざと壊して検証が効いていることを確認する**

`[menuItemId].tsx` の `isNew` を `params.menuItemId === 'New'`（大文字）に変える。
Expected: FAIL。新規系の 3 件が落ちる（`existingItem` が `undefined` なので「メニューが見つかりません」になる）。

次に `!isNew && existingItem === undefined` のガードを消す。
Expected: FAIL。「存在しない menuItemId なら『見つかりません』を出す」が落ちる。

次に `menu/index.tsx` の削除ボタンの `accessibilityLabel` から件数を外す。
Expected: FAIL。「カテゴリ削除は配下の項目も消えることを文言で知らせる」が落ちる。

次に `formatPriceYen` の `toLocaleString` を `String` に変える。
Expected: FAIL。「3 桁区切りと円記号を付ける」「10 万円台も区切る」が落ちる。

**4 つとも確認したら元に戻す。**

- [ ] **Step 10: カバレッジ・型・lint を通してコミット**

Run: `npm run test -w @meshimap/mobile && npm run typecheck -w @meshimap/mobile && npm run lint`
Expected: すべて成功、カバレッジ 100%。

```bash
git add 'apps/mobile/src/app/(owner)/shop/menu' apps/mobile/src/components/owner apps/mobile/src/lib/format-price.ts apps/mobile/src/lib/format-price.test.ts
git commit -m "feat(mobile): メニュー一覧と編集画面を追加"
```

---

## Task 8-21: レビュー一覧と返信・通報

**Files:**

- Create: `apps/mobile/src/components/owner/owner-review-card.tsx`
- Create: `apps/mobile/src/components/owner/owner-review-card.test.tsx`
- Create: `apps/mobile/src/app/(owner)/(tabs)/reviews.tsx`
- Create: `apps/mobile/src/app/(owner)/(tabs)/reviews.test.tsx`
- Create: `apps/mobile/src/app/(owner)/reviews/_layout.tsx`
- Create: `apps/mobile/src/app/(owner)/reviews/[reviewId]/reply.tsx`
- Create: `apps/mobile/src/app/(owner)/reviews/[reviewId]/reply.test.tsx`
- Modify: `apps/mobile/src/constants/owner.ts`（通報理由の一覧と返信本文の上限を追加）

**Interfaces:**

- Consumes: `useOwnerReviews` / `useSaveReviewReply` / `useDeleteReviewReply` / `useReportReview`（8-15）、`OwnerReview`（8-15 の `features/owner/types.ts`）、`useActiveShop`（8-17）、`reviewReplyInputSchema` / `reviewReportCreateSchema` / `REVIEW_REPLY_BODY_MAX`（Task 8-3、`@meshimap/core`）、`Badge` / `Button` / `Card` / `EmptyState` / `ErrorState` / `Icon` / `Input` / `Skeleton`、`date-fns` の `format`
- Produces:
  - `REPORT_REASON_OPTIONS: readonly { value: ReportReason; label: string }[]`
  - `OwnerReviewCard({ item, onPress, testID }: OwnerReviewCardProps)`
  - `formatReviewDate(iso: string): string`（`src/lib/format-date.ts`）
  - 2 画面（`(tabs)/reviews` / `reviews/[reviewId]/reply`）＋ `reviews/_layout`

### 未返信を「バッジ」で出す理由

一覧の目的は「どれに返していないか」を数秒で見つけることに尽きる。並べ替えをサーバに足す案もあったが、

- `GET /owner/shops/:shopId/reviews` は既に `created_at DESC` で返す（Task 8-10）。ここに「未返信を先に」を足すと、ページングのカーソルが返信の有無で動く不安定なものになる
- 返信すると並びが変わるので、返信直後に「さっき返したレビューが消えた」ように見える

**バッジなら並びは変わらず、返信すればバッジだけが消える。** 実装もサーバ変更ゼロで済む。

### 通報を返信画面に置く理由

通報は「返信するかわりに運営へ回す」操作であり、返信画面で本文を読んだ直後にしか判断できない。一覧に通報ボタンを置くと、本文を読まずに押せてしまう。

- [ ] **Step 1: `formatReviewDate` の失敗するテストを書く**

```ts
// apps/mobile/src/lib/format-date.test.ts
import { describe, expect, it } from '@jest/globals';

import { formatReviewDate } from './format-date';

describe('formatReviewDate', () => {
  it('ISO 文字列を「2026年9月15日」の形にする', () => {
    expect(formatReviewDate('2026-09-15T03:04:05.000Z')).toBe('2026年9月15日');
  });

  it('月日を 0 埋めしない', () => {
    expect(formatReviewDate('2026-01-02T00:00:00.000Z')).toBe('2026年1月2日');
  });

  it('解釈できない文字列はそのまま返す（画面を落とさない）', () => {
    expect(formatReviewDate('not-a-date')).toBe('not-a-date');
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/mobile -- src/lib/format-date.test.ts`
Expected: FAIL。`Cannot find module './format-date'`。

- [ ] **Step 3: `formatReviewDate` を実装する**

```ts
// apps/mobile/src/lib/format-date.ts
import { format, isValid, parseISO } from 'date-fns';

/** 日付の表示形式。年月日だけで、時刻は出さない（レビューに分単位の情報は要らない） */
const REVIEW_DATE_PATTERN = 'yyyy年M月d日';

/**
 * ISO 文字列を日本語の年月日にする。
 * 壊れた文字列でも例外を投げず元の値を返す。1 件の不正データで一覧全体が真っ白になるのを防ぐ。
 */
export function formatReviewDate(iso: string): string {
  const parsed = parseISO(iso);
  if (!isValid(parsed)) {
    return iso;
  }
  return format(parsed, REVIEW_DATE_PATTERN);
}
```

**`format` は端末のタイムゾーンで表示する。API は UTC の ISO 文字列を返すので、日本時間の深夜に投稿されたレビューは端末が JST なら翌日として出る。これは「利用者から見た日付」として正しい。未確認：CI の TZ 設定が UTC のままだと `'2026-09-15T03:04:05.000Z'` の期待値は JST でも UTC でも 9月15日になるので通るが、境界時刻のテストを足す場合は `jest.config.js` の `globalSetup` で TZ を固定する必要がある。**

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/mobile -- src/lib/format-date.test.ts`
Expected: PASS（3 件）。

- [ ] **Step 5: 定数を追加する**

```ts
// apps/mobile/src/constants/owner.ts に追記
import { REPORT_REASONS } from '@meshimap/core';
import type { ReportReason } from '@meshimap/core';

/** 通報理由の表示名。値の一覧は @meshimap/core の REPORT_REASONS が定義元 */
const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  spam: '宣伝・スパム',
  abuse: '誹謗中傷',
  privacy: '個人情報が含まれる',
  falsehood: '事実と異なる',
  other: 'その他',
};

export const REPORT_REASON_OPTIONS: readonly { value: ReportReason; label: string }[] =
  REPORT_REASONS.map((value) => ({ value, label: REPORT_REASON_LABELS[value] }));
```

**`REPORT_REASONS` と `ReportReason` は Task 8-3 で `packages/core/src/schema.ts` に置いた `reviewReportSchema` の元になっている一覧である。`Record<ReportReason, string>` にしておくと、core 側に理由が 1 つ増えた瞬間にモバイルが型エラーになる。** ラベルを付け忘れたまま出荷することがなくなる。

- [ ] **Step 6: `OwnerReviewCard` のテストを書いて実装する**

```tsx
// apps/mobile/src/components/owner/owner-review-card.test.tsx
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { OwnerReviewCard } from './owner-review-card';

const unanswered = {
  review: {
    id: 'rev_1',
    rating: 4,
    body: 'スープが好みでした',
    createdAt: '2026-09-15T03:04:05.000Z',
    authorName: 'たろう',
  },
  reply: null,
};
const answered = {
  ...unanswered,
  reply: { body: 'ありがとうございます', updatedAt: '2026-09-16T00:00:00.000Z' },
};

describe('OwnerReviewCard', () => {
  it('投稿者名・本文・日付を出す', () => {
    render(<OwnerReviewCard item={unanswered} onPress={jest.fn()} testID="card" />);
    expect(screen.getByText('たろう')).toBeTruthy();
    expect(screen.getByText('スープが好みでした')).toBeTruthy();
    expect(screen.getByText('2026年9月15日')).toBeTruthy();
  });

  it('星の数を読み上げ可能な文言で出す', () => {
    render(<OwnerReviewCard item={unanswered} onPress={jest.fn()} testID="card" />);
    expect(screen.getByLabelText('5 段階中 4')).toBeTruthy();
  });

  it('未返信ならバッジを出す', () => {
    render(<OwnerReviewCard item={unanswered} onPress={jest.fn()} testID="card" />);
    expect(screen.getByText('未返信')).toBeTruthy();
  });

  it('返信済みならバッジを出さず、返信本文を出す', () => {
    render(<OwnerReviewCard item={answered} onPress={jest.fn()} testID="card" />);
    expect(screen.queryByText('未返信')).toBeNull();
    expect(screen.getByText('ありがとうございます')).toBeTruthy();
  });

  it('押すと onPress が呼ばれる', () => {
    const onPress = jest.fn();
    render(<OwnerReviewCard item={unanswered} onPress={onPress} testID="card" />);
    fireEvent.press(screen.getByTestId('card'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
```

```tsx
// apps/mobile/src/components/owner/owner-review-card.tsx
import { Text, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { OwnerReview } from '@/features/owner/types';
import { formatReviewDate } from '@/lib/format-date';

export interface OwnerReviewCardProps {
  item: OwnerReview;
  onPress: () => void;
  testID?: string | undefined;
}

/** 評価の最大値。API の rating は 1〜5 の整数（ownerReviewSchema で検証済み） */
const RATING_MAX = 5;

const UNANSWERED_LABEL = '未返信';
const REPLY_PREFIX_LABEL = '店舗からの返信';

export function OwnerReviewCard({ item, onPress, testID }: OwnerReviewCardProps) {
  return (
    <Card onPress={onPress} testID={testID}>
      <View className="flex-row items-center justify-between">
        <Text className="text-base text-neutral-900">{item.review.authorName}</Text>
        {item.reply === null && <Badge label={UNANSWERED_LABEL} tone="warning" />}
      </View>
      {/* 星を絵文字で描くと読み上げが「星星星星」になる。数値をそのまま読ませる */}
      <Text
        accessibilityLabel={`${RATING_MAX} 段階中 ${item.review.rating}`}
        className="mt-1 text-sm text-neutral-700"
      >
        {'★'.repeat(item.review.rating)}
        {'☆'.repeat(RATING_MAX - item.review.rating)}
      </Text>
      <Text className="mt-2 text-sm text-neutral-800">{item.review.body}</Text>
      <Text className="mt-2 text-xs text-neutral-500">
        {formatReviewDate(item.review.createdAt)}
      </Text>
      {item.reply !== null && (
        <View className="mt-3 rounded-md bg-neutral-100 p-2">
          <Text className="text-xs text-neutral-500">{REPLY_PREFIX_LABEL}</Text>
          <Text className="mt-1 text-sm text-neutral-800">{item.reply.body}</Text>
        </View>
      )}
    </Card>
  );
}
```

Run: `npm run test -w @meshimap/mobile -- src/components/owner/owner-review-card.test.tsx`
Expected: PASS（5 件）。

- [ ] **Step 7: レビュータブのテストを書く**

```tsx
// apps/mobile/src/app/(owner)/(tabs)/reviews.test.tsx
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { createQueryWrapper } from '@/features/owner/testing/query-wrapper';

import OwnerReviewsScreen from './reviews';

jest.mock('@/features/owner/api');
const mockedApi = jest.requireMock<typeof import('@/features/owner/api')>('@/features/owner/api');
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const shop = {
  id: 'shp_1',
  name: 'ラーメン太郎',
  status: 'published',
  ratingAvg: 4.2,
  ratingCount: 3,
};
const review = (id: string, hasReply: boolean) => ({
  review: {
    id,
    rating: 4,
    body: '本文',
    createdAt: '2026-09-15T00:00:00.000Z',
    authorName: 'たろう',
  },
  reply: hasReply ? { body: '返信', updatedAt: '2026-09-16T00:00:00.000Z' } : null,
});

function renderScreen() {
  const { wrapper: Wrapper } = createQueryWrapper();
  return render(<OwnerReviewsScreen />, { wrapper: Wrapper });
}

describe('レビュータブ', () => {
  it('取得中はスケルトンを出す', () => {
    mockedApi.fetchOwnedShops.mockReturnValue(new Promise(() => undefined));
    renderScreen();
    expect(screen.getByTestId('reviews-skeleton')).toBeTruthy();
  });

  it('0 件なら空状態を出す', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchOwnerReviews.mockResolvedValue([]);
    renderScreen();
    await waitFor(() => expect(screen.getByText('まだレビューがありません')).toBeTruthy());
  });

  it('未返信の件数を見出しに出す', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchOwnerReviews.mockResolvedValue([
      review('rev_1', false),
      review('rev_2', true),
      review('rev_3', false),
    ]);
    renderScreen();
    await waitFor(() => expect(screen.getByText('未返信 2 件 / 全 3 件')).toBeTruthy());
  });

  it('全件返信済みなら「未返信はありません」と出す', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchOwnerReviews.mockResolvedValue([review('rev_1', true)]);
    renderScreen();
    await waitFor(() => expect(screen.getByText('未返信はありません / 全 1 件')).toBeTruthy());
  });

  it('カードを押すと返信画面へ遷移する', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchOwnerReviews.mockResolvedValue([review('rev_1', false)]);
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('review-rev_1')).toBeTruthy());
    fireEvent.press(screen.getByTestId('review-rev_1'));
    expect(mockPush).toHaveBeenCalledWith('/reviews/rev_1/reply');
  });

  it('取得に失敗したら再試行できる', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchOwnerReviews.mockRejectedValue(new Error('落ちた'));
    renderScreen();
    await waitFor(() => expect(screen.getByText('再試行')).toBeTruthy());
    mockedApi.fetchOwnerReviews.mockResolvedValue([review('rev_1', false)]);
    fireEvent.press(screen.getByText('再試行'));
    await waitFor(() => expect(screen.getByTestId('review-rev_1')).toBeTruthy());
  });

  it('店舗が 0 件なら空状態を出し、レビューは取りに行かない', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([]);
    renderScreen();
    await waitFor(() => expect(screen.getByText('店舗がまだありません')).toBeTruthy());
    expect(mockedApi.fetchOwnerReviews).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 8: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/(tabs)/reviews.test.tsx'`
Expected: FAIL。`Cannot find module './reviews'`。

- [ ] **Step 9: レビュータブを実装する**

```tsx
// apps/mobile/src/app/(owner)/(tabs)/reviews.tsx
import { useRouter } from 'expo-router';
import { MessageSquareText, Store } from 'lucide-react-native';
import { ScrollView, Text, View } from 'react-native';

import { OwnerReviewCard } from '@/components/owner/owner-review-card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { OWNER_ONBOARDING_STATUS_ROUTE } from '@/constants/auth';
import { useOwnerReviews } from '@/features/owner/queries';
import { useActiveShop } from '@/features/owner/use-active-shop';

const REVIEW_REPLY_ROUTE_PREFIX = '/reviews';
const NO_UNANSWERED_LABEL = '未返信はありません';

function buildSummary(unansweredCount: number, totalCount: number): string {
  const head = unansweredCount === 0 ? NO_UNANSWERED_LABEL : `未返信 ${unansweredCount} 件`;
  return `${head} / 全 ${totalCount} 件`;
}

export default function OwnerReviewsScreen() {
  const router = useRouter();
  const activeShop = useActiveShop();
  const shopId = activeShop.shopId;
  const reviewsQuery = useOwnerReviews(shopId);

  if (activeShop.isLoading) {
    return <Skeleton height={400} testID="reviews-skeleton" />;
  }
  if (activeShop.isError) {
    return (
      <ErrorState
        description="店舗を取得できませんでした"
        onRetry={() => void activeShop.refetch()}
      />
    );
  }
  if (shopId === null) {
    return (
      <EmptyState
        icon={Store}
        title="店舗がまだありません"
        description="申請が承認されるとレビューが届きます"
        action={{
          label: '申請状況を見る',
          onPress: () => router.push(OWNER_ONBOARDING_STATUS_ROUTE),
        }}
      />
    );
  }
  if (reviewsQuery.isLoading) {
    return <Skeleton height={400} testID="reviews-skeleton" />;
  }
  if (reviewsQuery.isError) {
    return (
      <ErrorState
        description="レビューを取得できませんでした"
        onRetry={() => void reviewsQuery.refetch()}
      />
    );
  }

  const reviews = reviewsQuery.data ?? [];
  const unansweredCount = reviews.filter((item) => item.reply === null).length;

  return (
    <ScrollView contentContainerClassName="gap-3 p-md">
      <Text className="text-sm text-neutral-600">
        {buildSummary(unansweredCount, reviews.length)}
      </Text>
      {reviews.length === 0 ? (
        <EmptyState
          icon={MessageSquareText}
          title="まだレビューがありません"
          description="来店した人が投稿すると、ここに届きます"
        />
      ) : (
        <View className="gap-3">
          {reviews.map((item) => (
            <OwnerReviewCard
              key={item.review.id}
              item={item}
              onPress={() => router.push(`${REVIEW_REPLY_ROUTE_PREFIX}/${item.review.id}/reply`)}
              testID={`review-${item.review.id}`}
            />
          ))}
        </View>
      )}
    </ScrollView>
  );
}
```

- [ ] **Step 10: テストを実行して通ることを確認する**

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/(tabs)/reviews.test.tsx'`
Expected: PASS（7 件）。

- [ ] **Step 11: 返信画面のテストを書く**

```tsx
// apps/mobile/src/app/(owner)/reviews/[reviewId]/reply.test.tsx
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { createQueryWrapper } from '@/features/owner/testing/query-wrapper';

import OwnerReviewReplyScreen from './reply';

jest.mock('@/features/owner/api');
const mockedApi = jest.requireMock<typeof import('@/features/owner/api')>('@/features/owner/api');

const mockBack = jest.fn();
let searchParams: Record<string, string> = { reviewId: 'rev_1' };
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack }),
  useLocalSearchParams: () => searchParams,
}));

const shop = {
  id: 'shp_1',
  name: 'ラーメン太郎',
  status: 'published',
  ratingAvg: 4,
  ratingCount: 1,
};
const item = (replyBody: string | null) => ({
  review: {
    id: 'rev_1',
    rating: 4,
    body: '本文',
    createdAt: '2026-09-15T00:00:00.000Z',
    authorName: 'たろう',
  },
  reply: replyBody === null ? null : { body: replyBody, updatedAt: '2026-09-16T00:00:00.000Z' },
});

function renderScreen() {
  const { wrapper: Wrapper } = createQueryWrapper();
  return render(<OwnerReviewReplyScreen />, { wrapper: Wrapper });
}

describe('レビュー返信画面', () => {
  it('元のレビュー本文を読めるように出す', async () => {
    searchParams = { reviewId: 'rev_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchOwnerReviews.mockResolvedValue([item(null)]);
    renderScreen();
    await waitFor(() => expect(screen.getByText('本文')).toBeTruthy());
  });

  it('既存の返信が入力欄に入る', async () => {
    searchParams = { reviewId: 'rev_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchOwnerReviews.mockResolvedValue([item('既存の返信')]);
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('reply-body').props.value).toBe('既存の返信'));
  });

  it('未返信なら削除ボタンを出さない', async () => {
    searchParams = { reviewId: 'rev_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchOwnerReviews.mockResolvedValue([item(null)]);
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('reply-body')).toBeTruthy());
    expect(screen.queryByText('返信を削除')).toBeNull();
  });

  it('空のまま保存するとエラー文言を出し、送信しない', async () => {
    searchParams = { reviewId: 'rev_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchOwnerReviews.mockResolvedValue([item(null)]);
    renderScreen();
    await waitFor(() => expect(screen.getByText('返信を送信')).toBeTruthy());
    fireEvent.press(screen.getByText('返信を送信'));
    await waitFor(() => expect(screen.getByText('返信内容を入力してください')).toBeTruthy());
    expect(mockedApi.saveReviewReply).not.toHaveBeenCalled();
  });

  it('入力して保存すると saveReviewReply を呼び、前の画面に戻る', async () => {
    searchParams = { reviewId: 'rev_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchOwnerReviews.mockResolvedValue([item(null)]);
    mockedApi.saveReviewReply.mockResolvedValue({
      body: 'ありがとうございます',
      updatedAt: '2026-09-17T00:00:00.000Z',
    });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('reply-body')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('reply-body'), 'ありがとうございます');
    fireEvent.press(screen.getByText('返信を送信'));
    await waitFor(() =>
      expect(mockedApi.saveReviewReply).toHaveBeenCalledWith('rev_1', 'ありがとうございます'),
    );
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
  });

  it('返信済みなら削除できる', async () => {
    searchParams = { reviewId: 'rev_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchOwnerReviews.mockResolvedValue([item('既存の返信')]);
    mockedApi.deleteReviewReply.mockResolvedValue(undefined);
    renderScreen();
    await waitFor(() => expect(screen.getByText('返信を削除')).toBeTruthy());
    fireEvent.press(screen.getByText('返信を削除'));
    await waitFor(() => expect(mockedApi.deleteReviewReply).toHaveBeenCalledWith('rev_1'));
  });

  it('通報は理由を選ぶまで送れない', async () => {
    searchParams = { reviewId: 'rev_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchOwnerReviews.mockResolvedValue([item(null)]);
    renderScreen();
    await waitFor(() => expect(screen.getByText('このレビューを通報する')).toBeTruthy());
    fireEvent.press(screen.getByText('このレビューを通報する'));
    expect(screen.getByTestId('report-submit').props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });

  it('理由を選ぶと通報できる', async () => {
    searchParams = { reviewId: 'rev_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchOwnerReviews.mockResolvedValue([item(null)]);
    mockedApi.reportReview.mockResolvedValue(undefined);
    renderScreen();
    await waitFor(() => expect(screen.getByText('このレビューを通報する')).toBeTruthy());
    fireEvent.press(screen.getByText('このレビューを通報する'));
    fireEvent.press(screen.getByText('誹謗中傷'));
    fireEvent.press(screen.getByTestId('report-submit'));
    await waitFor(() =>
      expect(mockedApi.reportReview).toHaveBeenCalledWith('rev_1', 'abuse', null),
    );
  });

  it('通報の詳細を書くと一緒に送る', async () => {
    searchParams = { reviewId: 'rev_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchOwnerReviews.mockResolvedValue([item(null)]);
    mockedApi.reportReview.mockResolvedValue(undefined);
    renderScreen();
    await waitFor(() => expect(screen.getByText('このレビューを通報する')).toBeTruthy());
    fireEvent.press(screen.getByText('このレビューを通報する'));
    fireEvent.press(screen.getByText('その他'));
    fireEvent.changeText(screen.getByTestId('report-detail'), '来店記録がありません');
    fireEvent.press(screen.getByTestId('report-submit'));
    await waitFor(() =>
      expect(mockedApi.reportReview).toHaveBeenCalledWith('rev_1', 'other', '来店記録がありません'),
    );
  });

  it('通報が済むと完了文言を出し、フォームを閉じる', async () => {
    searchParams = { reviewId: 'rev_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchOwnerReviews.mockResolvedValue([item(null)]);
    mockedApi.reportReview.mockResolvedValue(undefined);
    renderScreen();
    await waitFor(() => expect(screen.getByText('このレビューを通報する')).toBeTruthy());
    fireEvent.press(screen.getByText('このレビューを通報する'));
    fireEvent.press(screen.getByText('誹謗中傷'));
    fireEvent.press(screen.getByTestId('report-submit'));
    await waitFor(() => expect(screen.getByText('通報を受け付けました')).toBeTruthy());
    expect(screen.queryByTestId('report-submit')).toBeNull();
  });

  it('一覧に無い reviewId なら「見つかりません」を出す', async () => {
    searchParams = { reviewId: 'rev_nope' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchOwnerReviews.mockResolvedValue([item(null)]);
    renderScreen();
    await waitFor(() => expect(screen.getByText('レビューが見つかりません')).toBeTruthy());
  });
});
```

- [ ] **Step 12: 返信画面と `reviews/_layout.tsx` を実装する**

```tsx
// apps/mobile/src/app/(owner)/reviews/_layout.tsx
import { Stack } from 'expo-router';

/** レビュー配下の画面タイトル。キーは expo-router のルート名 */
const REVIEW_STACK_TITLES: Record<string, string> = {
  '[reviewId]/reply': 'レビューに返信',
};

export default function OwnerReviewsStackLayout() {
  return (
    <Stack>
      {Object.entries(REVIEW_STACK_TITLES).map(([name, title]) => (
        <Stack.Screen key={name} name={name} options={{ title }} />
      ))}
    </Stack>
  );
}
```

```tsx
// apps/mobile/src/app/(owner)/reviews/[reviewId]/reply.tsx
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MessageSquareText } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { ReportReason } from '@meshimap/core';

import { OwnerReviewCard } from '@/components/owner/owner-review-card';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { REVIEW_REPLY_BODY_MAX } from '@meshimap/core';

import { REPORT_REASON_OPTIONS } from '@/constants/owner';
import {
  useDeleteReviewReply,
  useOwnerReviews,
  useReportReview,
  useSaveReviewReply,
} from '@/features/owner/queries';
import { useActiveShop } from '@/features/owner/use-active-shop';

const REPLY_REQUIRED_MESSAGE = '返信内容を入力してください';
const REPORT_DONE_MESSAGE = '通報を受け付けました';

export default function OwnerReviewReplyScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ reviewId: string }>();
  const activeShop = useActiveShop();
  const shopId = activeShop.shopId;
  const reviewsQuery = useOwnerReviews(shopId);
  const saveReply = useSaveReviewReply(shopId ?? '');
  const deleteReply = useDeleteReviewReply(shopId ?? '');
  const reportReviewMutation = useReportReview();

  const [body, setBody] = useState('');
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [isReportOpen, setIsReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState<ReportReason | null>(null);
  const [reportDetail, setReportDetail] = useState('');
  const [isReported, setIsReported] = useState(false);

  const target = (reviewsQuery.data ?? []).find((entry) => entry.review.id === params.reviewId);

  // 一覧が届いた時点で既存の返信を流し込む。以降は入力で上書きされる
  useEffect(() => {
    if (target?.reply != null) {
      setBody(target.reply.body);
    }
  }, [target?.reply]);

  if (shopId === null || reviewsQuery.isLoading) {
    return <Skeleton height={320} testID="reply-skeleton" />;
  }
  if (reviewsQuery.isError) {
    return (
      <ErrorState
        description="レビューを取得できませんでした"
        onRetry={() => void reviewsQuery.refetch()}
      />
    );
  }
  if (target === undefined) {
    return (
      <EmptyState
        icon={MessageSquareText}
        title="レビューが見つかりません"
        description="運営によって非表示にされた可能性があります"
        action={{ label: '一覧に戻る', onPress: () => router.back() }}
      />
    );
  }

  const onSubmitReply = () => {
    if (body.trim() === '') {
      setBodyError(REPLY_REQUIRED_MESSAGE);
      return;
    }
    setBodyError(null);
    saveReply.mutate({ reviewId: params.reviewId, body }, { onSuccess: () => router.back() });
  };

  const onSubmitReport = () => {
    // ボタンが disabled なので通常は到達しないが、型を絞るために null を弾く
    if (reportReason === null) {
      return;
    }
    reportReviewMutation.mutate(
      {
        reviewId: params.reviewId,
        reason: reportReason,
        detail: reportDetail === '' ? null : reportDetail,
      },
      {
        onSuccess: () => {
          setIsReported(true);
          setIsReportOpen(false);
        },
      },
    );
  };

  return (
    <ScrollView contentContainerClassName="gap-3 p-md">
      {/* 一覧と同じ見た目で出す。返信前に本文を読み直せることが目的 */}
      <OwnerReviewCard item={target} onPress={() => undefined} testID="reply-source" />

      <Input
        label="返信"
        value={body}
        onChangeText={setBody}
        isMultiline
        isRequired
        maxLength={REVIEW_REPLY_BODY_MAX}
        errorMessage={bodyError ?? undefined}
        placeholder="ご来店ありがとうございました"
        testID="reply-body"
      />
      <Button label="返信を送信" onPress={onSubmitReply} isLoading={saveReply.isPending} />
      {/* 未返信のときに「削除」を出すと、何も無いものを消す操作になる */}
      {target.reply !== null && (
        <Button
          label="返信を削除"
          variant="danger"
          onPress={() => deleteReply.mutate(params.reviewId, { onSuccess: () => router.back() })}
          isLoading={deleteReply.isPending}
        />
      )}

      {isReported ? (
        <Text className="text-sm text-neutral-600">{REPORT_DONE_MESSAGE}</Text>
      ) : isReportOpen ? (
        <Card testID="report-form">
          <Text className="mb-2 text-sm text-neutral-700">通報の理由を選んでください</Text>
          <View className="gap-2">
            {REPORT_REASON_OPTIONS.map((option) => (
              <Pressable
                key={option.value}
                accessibilityRole="radio"
                accessibilityState={{ selected: reportReason === option.value }}
                onPress={() => setReportReason(option.value)}
                testID={`report-reason-${option.value}`}
              >
                <Text className="text-base text-neutral-900">{option.label}</Text>
              </Pressable>
            ))}
          </View>
          <Input
            label="詳細（任意）"
            value={reportDetail}
            onChangeText={setReportDetail}
            isMultiline
            testID="report-detail"
          />
          <Button
            label="通報する"
            variant="danger"
            onPress={onSubmitReport}
            isDisabled={reportReason === null}
            isLoading={reportReviewMutation.isPending}
            testID="report-submit"
          />
        </Card>
      ) : (
        <Button
          label="このレビューを通報する"
          variant="ghost"
          onPress={() => setIsReportOpen(true)}
        />
      )}
    </ScrollView>
  );
}
```

**`useReportReview` は Task 8-15 の一覧に入れていなかったので、`features/owner/queries.ts` に足す。** 通報はサーバ側で `review_reports` に行を足すだけで、レビュー一覧の見え方は変わらないため、**無効化するクエリキーは無い**（`onSuccess` で何も `invalidateQueries` しない唯一のミューテーションになる）。

```ts
export function useReportReview() {
  return useMutation({
    mutationFn: (input: { reviewId: string; reason: ReportReason; detail: string | null }) =>
      reportReview(input.reviewId, input.reason, input.detail),
  });
}
```

`api.ts` の `reportReview` の `reason` 引数の型も `string` から `ReportReason` へ狭める。**`string` のままだと、画面が `'abuse '`（末尾空白）のような値を送っても型が通ってしまい、サーバで 422 になる経路が残る。**

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/reviews/[reviewId]/reply.test.tsx'`
Expected: PASS（11 件）。

- [ ] **Step 13: わざと壊して検証が効いていることを確認する**

`reply.tsx` の `if (body.trim() === '')` を `if (body === '')` に変える。
Expected: PASS のまま落ちない。**これは検出できない変異なので、`reply.test.tsx` に「空白だけの返信は送信しない」テストを 1 件足して殺す。**

```tsx
it('空白だけの返信は送信しない', async () => {
  searchParams = { reviewId: 'rev_1' };
  mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
  mockedApi.fetchOwnerReviews.mockResolvedValue([item(null)]);
  renderScreen();
  await waitFor(() => expect(screen.getByTestId('reply-body')).toBeTruthy());
  fireEvent.changeText(screen.getByTestId('reply-body'), '   ');
  fireEvent.press(screen.getByText('返信を送信'));
  await waitFor(() => expect(screen.getByText('返信内容を入力してください')).toBeTruthy());
  expect(mockedApi.saveReviewReply).not.toHaveBeenCalled();
});
```

**テストを足してから先へ進む（除外は選択肢にない）。**

次に `reviews.tsx` の `unansweredCount` を `reviews.filter((item) => item.reply !== null).length` に変える（条件を反転）。
Expected: FAIL。「未返信の件数を見出しに出す」（2 件 → 1 件）と「全件返信済みなら…」が落ちる。

次に `reply.tsx` の `isDisabled={reportReason === null}` を消す。
Expected: FAIL。「通報は理由を選ぶまで送れない」が落ちる。

次に `owner-review-card.tsx` の `accessibilityLabel` を消す。
Expected: FAIL。「星の数を読み上げ可能な文言で出す」が落ちる。

**4 つとも確認したら元に戻し、追加テストを含めて緑になることを確認する。**

- [ ] **Step 14: カバレッジ・型・lint を通してコミット**

Run: `npm run test -w @meshimap/mobile && npm run typecheck -w @meshimap/mobile && npm run lint`
Expected: すべて成功、カバレッジ 100%。

```bash
git add 'apps/mobile/src/app/(owner)' apps/mobile/src/components/owner apps/mobile/src/constants/owner.ts apps/mobile/src/features/owner apps/mobile/src/lib/format-date.ts apps/mobile/src/lib/format-date.test.ts
git commit -m "feat(mobile): レビュー一覧と返信・通報画面を追加"
```

---

## Task 8-22: クーポンとオンボーディング（申請状況・書類・再提出）

**Files:**

- Create: `apps/mobile/src/components/owner/campaign-row.tsx`
- Create: `apps/mobile/src/components/owner/campaign-row.test.tsx`
- Create: `apps/mobile/src/app/(owner)/campaigns/_layout.tsx`
- Create: `apps/mobile/src/app/(owner)/campaigns/index.tsx`
- Create: `apps/mobile/src/app/(owner)/campaigns/index.test.tsx`
- Create: `apps/mobile/src/app/(owner)/campaigns/[campaignId].tsx`
- Create: `apps/mobile/src/app/(owner)/campaigns/[campaignId].test.tsx`
- Create: `apps/mobile/src/app/(owner)/onboarding/_layout.tsx`
- Create: `apps/mobile/src/app/(owner)/onboarding/status.tsx`
- Create: `apps/mobile/src/app/(owner)/onboarding/status.test.tsx`
- Create: `apps/mobile/src/app/(owner)/onboarding/apply.tsx`
- Create: `apps/mobile/src/app/(owner)/onboarding/apply.test.tsx`
- Modify: `apps/mobile/src/app/(owner)/(tabs)/shop.tsx`（区画に `campaigns` を 7 つ目として追加）
- Modify: `apps/mobile/src/app/(owner)/(tabs)/shop.test.tsx`（クーポン区画のテストを 2 件追加）
- Modify: `apps/mobile/src/constants/owner.ts`（クーポン状態・申請状態・書類種別の表示名を追加）
- Modify: `apps/mobile/src/constants/owner.test.ts`（追加した定数のテスト）
- Modify: `apps/mobile/src/features/owner/api.ts`（`uploadApplicationDocument` の第 1 引数を `DocumentKind` に狭める）
- Modify: `apps/mobile/src/features/owner/queries.ts`（`useResubmitApplication` の無効化キーを 2 本にする）

**Interfaces:**

- Consumes: `useCampaigns` / `useCreateCampaign` / `useUpdateCampaign` / `useDeleteCampaign` / `useApplication` / `useUploadApplicationDocument` / `useResubmitApplication`（8-15）、`formatPriceYen`（8-20）、`useActiveShop`（8-17）、`campaignInputSchema` / `CampaignInput`（Task 8-3）、`pickShopImage`（8-19）、`NEW_ENTITY_ROUTE_SEGMENT`（8-15）、`formatReviewDate`（8-21）、`Badge` / `Button` / `Card` / `EmptyState` / `ErrorState` / `Icon` / `Input` / `Skeleton`
- Produces:
  - `CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string>`
  - `APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string>`
  - `DOCUMENT_KIND_OPTIONS: readonly { value: DocumentKind; label: string }[]`
  - `CampaignRow({ campaign, onPress, testID }: CampaignRowProps)`
  - 4 画面（`campaigns/index` / `campaigns/[campaignId]` / `onboarding/status` / `onboarding/apply`）＋ 2 つの `_layout`

### クーポンの入口を店舗ハブに置く

クーポンは「店に紐づく販促物」であり、タブを 6 つに増やすほど日常的に触るものではない。**店舗ハブ（`(tabs)/shop.tsx`）の 7 つ目の区画として置く。** タブは Phase 8 の設計どおり 5 つのまま変えない。

これに伴い Task 8-18 で作った `shop.test.tsx` の「区画を押すと対応する画面へ遷移する」テストはそのまま通るが、**区画一覧の件数を検証しているテストがあれば 6 → 7 に直す**。Task 8-18 の時点では件数を直接数えるテストを書いていないので、必要なのは新しい区画ぶんのテスト追加だけである。

### 申請フローの状態を 4 つに閉じる

`shopApplicationSchema.status` は `pending` / `approved` / `rejected` / `returned` の 4 値（8-15）。画面はこの 4 値で分岐し、**それ以外の状態を持たない**。

| status                             | status.tsx の表示                   | 「書類を出す」導線                     |
| ---------------------------------- | ----------------------------------- | -------------------------------------- |
| （未申請＝`application === null`） | 「まだ申請していません」            | 出す                                   |
| `pending`                          | 「審査中です」                      | 出さない（差し替えは運営の手間になる） |
| `returned`                         | 「差し戻されました」＋ `reviewNote` | 出す（再提出のため）                   |
| `rejected`                         | 「却下されました」＋ `reviewNote`   | 出さない                               |
| `approved`                         | 「承認されました」                  | 出さない                               |

**`reviewNote` は `returned` と `rejected` のときだけ出す。** `pending` / `approved` で運営メモが見えると、内部の判断材料が漏れる。

- [ ] **Step 1: 表示名の定数を追加する**

```ts
// apps/mobile/src/constants/owner.ts に追記
import type { Campaign, ShopApplication } from '@/features/owner/types';

/**
 * 値の集合は Task 8-15 の `campaignSchema` / `shopApplicationSchema` が定義元。
 * そこから型を引くことで、スキーマに値が増えたら Record の対応漏れが型エラーになる。
 * `@meshimap/core` からは引けない。DISCOUNT_TYPES / CAMPAIGN_STATUSES / APPLICATION_STATUSES は
 * `apps/api/src/db/constants.ts` にあり、モバイルは `apps/api` に依存できないため（実ファイルで確認済み）。
 */
export type DiscountType = Campaign['discountType'];
export type CampaignStatus = Campaign['status'];
export type ApplicationStatus = ShopApplication['status'];

/** クーポン状態の表示名 */
export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: '下書き',
  published: '公開中',
  ended: '終了',
};

/** 割引種別の表示名。ラジオの並びがそのままこの順になる */
const DISCOUNT_TYPE_LABELS: Record<DiscountType, string> = {
  percent: '割合（%）',
  yen: '金額（円）',
  gift: 'サービス品',
};

export const DISCOUNT_TYPE_OPTIONS: readonly { value: DiscountType; label: string }[] = (
  Object.entries(DISCOUNT_TYPE_LABELS) as readonly [DiscountType, string][]
).map(([value, label]) => ({ value, label }));

/** 申請状態の表示名 */
export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  pending: '審査中',
  approved: '承認済み',
  rejected: '却下',
  returned: '差し戻し',
};

/**
 * 書類の種類。`shop_applications.documents` は JSON 列で、`kind` に CHECK 制約は無い
 *（`0000_init.sql` の shop_applications には `ck_shop_applications_documents_json` しか無いことを実ファイルで確認済み）。
 * サーバ側（Task 8-14）も `kind === ''` を 422 で弾くだけで、値の一覧は持たない。
 * つまりこれは **画面が提示する選択肢** であって、DB でも API でも制約ではない。
 * だから突合テストの対象にはしない。一覧に無い kind が保存されていた場合は
 * `apply.tsx` が生の値をそのまま表示する（審査するのは人間なので、消すより見えるほうがよい）。
 */
export const DOCUMENT_KINDS = ['business-license', 'identity', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  'business-license': '営業許可証',
  identity: '本人確認書類',
  other: 'その他',
};

export const DOCUMENT_KIND_OPTIONS: readonly { value: DocumentKind; label: string }[] =
  DOCUMENT_KINDS.map((value) => ({ value, label: DOCUMENT_KIND_LABELS[value] }));

/** 「書類を出す」導線を見せる申請状態。未申請（null）は呼び出し側で別扱いにする */
export const RESUBMITTABLE_APPLICATION_STATUSES: readonly ApplicationStatus[] = ['returned'];
```

**`Object.entries` の戻り値に型注釈を当てているのは、TypeScript が `Record<K, V>` の `entries` を `[string, V][]` としか推論しないため。** `as` を使うのはここだけで、キーの集合が `DISCOUNT_TYPE_LABELS` のキーと同一であることは直前の Record 定義が保証している。

**この一覧を増やしてもサーバの変更は要らない。** Task 8-14 のルートは `kind` を非空文字列としか見ないので、選択肢の追加はモバイルだけで閉じる。

- [ ] **Step 2: `CampaignRow` のテストを書く**

```tsx
// apps/mobile/src/components/owner/campaign-row.test.tsx
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { CampaignRow } from './campaign-row';

const campaign = {
  id: 'cmp_1',
  title: '雨の日サービス',
  body: 'ドリンク 1 杯',
  discountType: 'gift' as const,
  discountValue: 0,
  startsOn: '2026-10-01',
  endsOn: '2026-10-31',
  status: 'published' as const,
};

describe('CampaignRow', () => {
  it('題と期間を出す', () => {
    render(<CampaignRow campaign={campaign} onPress={jest.fn()} testID="row" />);
    expect(screen.getByText('雨の日サービス')).toBeTruthy();
    expect(screen.getByText('2026-10-01 〜 2026-10-31')).toBeTruthy();
  });

  it('公開中はブランド色のバッジを出す', () => {
    render(<CampaignRow campaign={campaign} onPress={jest.fn()} testID="row" />);
    expect(screen.getByText('公開中')).toBeTruthy();
  });

  it('下書きは「下書き」と出す', () => {
    render(
      <CampaignRow campaign={{ ...campaign, status: 'draft' }} onPress={jest.fn()} testID="row" />,
    );
    expect(screen.getByText('下書き')).toBeTruthy();
  });

  it('終了は「終了」と出す', () => {
    render(
      <CampaignRow campaign={{ ...campaign, status: 'ended' }} onPress={jest.fn()} testID="row" />,
    );
    expect(screen.getByText('終了')).toBeTruthy();
  });

  it('percent は「10% オフ」と出す', () => {
    render(
      <CampaignRow
        campaign={{ ...campaign, discountType: 'percent', discountValue: 10 }}
        onPress={jest.fn()}
        testID="row"
      />,
    );
    expect(screen.getByText('10% オフ')).toBeTruthy();
  });

  it('yen は「¥500 オフ」と出す', () => {
    render(
      <CampaignRow
        campaign={{ ...campaign, discountType: 'yen', discountValue: 500 }}
        onPress={jest.fn()}
        testID="row"
      />,
    );
    expect(screen.getByText('¥500 オフ')).toBeTruthy();
  });

  it('gift は金額を出さず「サービス品」と出す', () => {
    render(<CampaignRow campaign={campaign} onPress={jest.fn()} testID="row" />);
    expect(screen.getByText('サービス品')).toBeTruthy();
    expect(screen.queryByText('¥0 オフ')).toBeNull();
  });

  it('押すと onPress が呼ばれる', () => {
    const onPress = jest.fn();
    render(<CampaignRow campaign={campaign} onPress={onPress} testID="row" />);
    fireEvent.press(screen.getByTestId('row'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: テストを実行して失敗を確認し、`CampaignRow` を実装する**

Run: `npm run test -w @meshimap/mobile -- src/components/owner/campaign-row.test.tsx`
Expected: FAIL。`Cannot find module './campaign-row'`。

```tsx
// apps/mobile/src/components/owner/campaign-row.tsx
import { Text, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import type { BadgeTone } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { CAMPAIGN_STATUS_LABELS } from '@/constants/owner';
import type { Campaign } from '@/features/owner/types';
import { formatPriceYen } from '@/lib/format-price';

export interface CampaignRowProps {
  campaign: Campaign;
  onPress: () => void;
  testID?: string | undefined;
}

const GIFT_LABEL = 'サービス品';
const PERIOD_SEPARATOR = ' 〜 ';

/** 状態ごとのバッジ色。値の集合は CAMPAIGN_STATUS_LABELS と同じなので Record で対応漏れを防ぐ */
const STATUS_TONES: Record<Campaign['status'], BadgeTone> = {
  draft: 'neutral',
  published: 'brand',
  ended: 'neutral',
};

/** 割引の表示。gift は金額 0 固定なので「¥0 オフ」ではなく品名扱いの文言にする */
function formatDiscount(campaign: Campaign): string {
  switch (campaign.discountType) {
    case 'percent':
      return `${campaign.discountValue}% オフ`;
    case 'yen':
      return `${formatPriceYen(campaign.discountValue)} オフ`;
    case 'gift':
      return GIFT_LABEL;
  }
}

export function CampaignRow({ campaign, onPress, testID }: CampaignRowProps) {
  return (
    <Card onPress={onPress} padding="sm" testID={testID}>
      <View className="flex-row items-center justify-between">
        <Text className="flex-1 text-base text-neutral-900">{campaign.title}</Text>
        <Badge
          label={CAMPAIGN_STATUS_LABELS[campaign.status]}
          tone={STATUS_TONES[campaign.status]}
        />
      </View>
      <Text className="mt-1 text-sm text-neutral-700">{formatDiscount(campaign)}</Text>
      <Text className="mt-1 text-xs text-neutral-500">
        {campaign.startsOn}
        {PERIOD_SEPARATOR}
        {campaign.endsOn}
      </Text>
    </Card>
  );
}
```

Run: `npm run test -w @meshimap/mobile -- src/components/owner/campaign-row.test.tsx`
Expected: PASS（8 件）。

- [ ] **Step 4: クーポン一覧・編集のテストを書く**

```tsx
// apps/mobile/src/app/(owner)/campaigns/index.test.tsx
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { createQueryWrapper } from '@/features/owner/testing/query-wrapper';

import OwnerCampaignListScreen from './index';

jest.mock('@/features/owner/api');
const mockedApi = jest.requireMock<typeof import('@/features/owner/api')>('@/features/owner/api');
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const shop = {
  id: 'shp_1',
  name: 'ラーメン太郎',
  status: 'published',
  ratingAvg: 0,
  ratingCount: 0,
};
const campaign = {
  id: 'cmp_1',
  title: '雨の日サービス',
  body: 'ドリンク 1 杯',
  discountType: 'gift' as const,
  discountValue: 0,
  startsOn: '2026-10-01',
  endsOn: '2026-10-31',
  status: 'published' as const,
};

function renderScreen() {
  const { wrapper: Wrapper } = createQueryWrapper();
  return render(<OwnerCampaignListScreen />, { wrapper: Wrapper });
}

describe('クーポン一覧', () => {
  it('0 件なら空状態を出す', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchCampaigns.mockResolvedValue([]);
    renderScreen();
    await waitFor(() => expect(screen.getByText('クーポンがまだありません')).toBeTruthy());
  });

  it('一覧を出す', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchCampaigns.mockResolvedValue([campaign]);
    renderScreen();
    await waitFor(() => expect(screen.getByText('雨の日サービス')).toBeTruthy());
  });

  it('行を押すと編集画面へ遷移する', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchCampaigns.mockResolvedValue([campaign]);
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('campaign-cmp_1')).toBeTruthy());
    fireEvent.press(screen.getByTestId('campaign-cmp_1'));
    expect(mockPush).toHaveBeenCalledWith('/campaigns/cmp_1');
  });

  it('「クーポンを作る」は new へ遷移する', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchCampaigns.mockResolvedValue([]);
    renderScreen();
    await waitFor(() => expect(screen.getByText('クーポンを作る')).toBeTruthy());
    fireEvent.press(screen.getByText('クーポンを作る'));
    expect(mockPush).toHaveBeenCalledWith('/campaigns/new');
  });

  it('取得に失敗したら再試行できる', async () => {
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchCampaigns.mockRejectedValue(new Error('落ちた'));
    renderScreen();
    await waitFor(() => expect(screen.getByText('再試行')).toBeTruthy());
    mockedApi.fetchCampaigns.mockResolvedValue([campaign]);
    fireEvent.press(screen.getByText('再試行'));
    await waitFor(() => expect(screen.getByText('雨の日サービス')).toBeTruthy());
  });
});
```

```tsx
// apps/mobile/src/app/(owner)/campaigns/[campaignId].test.tsx
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { createQueryWrapper } from '@/features/owner/testing/query-wrapper';

import OwnerCampaignEditScreen from './[campaignId]';

jest.mock('@/features/owner/api');
const mockedApi = jest.requireMock<typeof import('@/features/owner/api')>('@/features/owner/api');

const mockBack = jest.fn();
let searchParams: Record<string, string> = { campaignId: 'new' };
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack }),
  useLocalSearchParams: () => searchParams,
}));

const shop = {
  id: 'shp_1',
  name: 'ラーメン太郎',
  status: 'published',
  ratingAvg: 0,
  ratingCount: 0,
};
const campaign = {
  id: 'cmp_1',
  title: '雨の日サービス',
  body: 'ドリンク 1 杯',
  discountType: 'gift' as const,
  discountValue: 0,
  startsOn: '2026-10-01',
  endsOn: '2026-10-31',
  status: 'published' as const,
};

function renderScreen() {
  const { wrapper: Wrapper } = createQueryWrapper();
  return render(<OwnerCampaignEditScreen />, { wrapper: Wrapper });
}

describe('クーポン編集', () => {
  it('新規なら空のフォームを出し、削除ボタンを出さない', async () => {
    searchParams = { campaignId: 'new' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchCampaigns.mockResolvedValue([]);
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('campaign-title')).toBeTruthy());
    expect(screen.getByTestId('campaign-title').props.value).toBe('');
    expect(screen.queryByText('削除')).toBeNull();
  });

  it('既存の値がフォームに入る', async () => {
    searchParams = { campaignId: 'cmp_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchCampaigns.mockResolvedValue([campaign]);
    renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId('campaign-title').props.value).toBe('雨の日サービス'),
    );
  });

  it('題が空なら保存できない', async () => {
    searchParams = { campaignId: 'cmp_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchCampaigns.mockResolvedValue([campaign]);
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('campaign-title')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('campaign-title'), '');
    fireEvent.press(screen.getByText('保存'));
    // Input は errorMessage を別の Text（accessibilityRole="alert"）として描く。
    // testID は TextInput に付くので、props ではなく alert の有無で見る
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(mockedApi.updateCampaign).not.toHaveBeenCalled();
  });

  it('終了日が開始日より前なら保存できない', async () => {
    searchParams = { campaignId: 'cmp_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchCampaigns.mockResolvedValue([campaign]);
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('campaign-ends-on')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('campaign-ends-on'), '2026-09-01');
    fireEvent.press(screen.getByText('保存'));
    await waitFor(() =>
      expect(screen.getByText('終了日は開始日以降である必要があります')).toBeTruthy(),
    );
    expect(mockedApi.updateCampaign).not.toHaveBeenCalled();
  });

  it('gift を選ぶと割引額の入力を出さない', async () => {
    searchParams = { campaignId: 'cmp_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchCampaigns.mockResolvedValue([campaign]);
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('campaign-title')).toBeTruthy());
    expect(screen.queryByTestId('campaign-discount-value')).toBeNull();
  });

  it('percent を選ぶと割引額の入力を出す', async () => {
    searchParams = { campaignId: 'cmp_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchCampaigns.mockResolvedValue([
      { ...campaign, discountType: 'percent', discountValue: 10 },
    ]);
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('campaign-discount-value')).toBeTruthy());
  });

  it('gift に切り替えると割引額が 0 に戻る', async () => {
    searchParams = { campaignId: 'cmp_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchCampaigns.mockResolvedValue([
      { ...campaign, discountType: 'percent', discountValue: 10 },
    ]);
    mockedApi.updateCampaign.mockResolvedValue(campaign);
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('campaign-discount-gift')).toBeTruthy());
    fireEvent.press(screen.getByTestId('campaign-discount-gift'));
    fireEvent.press(screen.getByText('保存'));
    await waitFor(() => expect(mockedApi.updateCampaign).toHaveBeenCalledTimes(1));
    expect(mockedApi.updateCampaign.mock.calls[0]?.[1]).toMatchObject({
      discountType: 'gift',
      discountValue: 0,
    });
  });

  it('保存すると createCampaign を呼び、前の画面に戻る', async () => {
    searchParams = { campaignId: 'new' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchCampaigns.mockResolvedValue([]);
    mockedApi.createCampaign.mockResolvedValue(campaign);
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('campaign-title')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('campaign-title'), '新クーポン');
    fireEvent.changeText(screen.getByTestId('campaign-body'), '説明');
    fireEvent.changeText(screen.getByTestId('campaign-starts-on'), '2026-11-01');
    fireEvent.changeText(screen.getByTestId('campaign-ends-on'), '2026-11-30');
    fireEvent.press(screen.getByText('保存'));
    await waitFor(() => expect(mockedApi.createCampaign).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
  });

  it('削除を押すと deleteCampaign を呼ぶ', async () => {
    searchParams = { campaignId: 'cmp_1' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchCampaigns.mockResolvedValue([campaign]);
    mockedApi.deleteCampaign.mockResolvedValue(undefined);
    renderScreen();
    await waitFor(() => expect(screen.getByText('削除')).toBeTruthy());
    fireEvent.press(screen.getByText('削除'));
    await waitFor(() => expect(mockedApi.deleteCampaign).toHaveBeenCalledWith('cmp_1'));
  });

  it('一覧に無い campaignId なら「見つかりません」を出す', async () => {
    searchParams = { campaignId: 'cmp_nope' };
    mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
    mockedApi.fetchCampaigns.mockResolvedValue([campaign]);
    renderScreen();
    await waitFor(() => expect(screen.getByText('クーポンが見つかりません')).toBeTruthy());
  });
});
```

- [ ] **Step 5: テストを実行して失敗を確認する**

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/campaigns'`
Expected: FAIL。`Cannot find module './index'` と `Cannot find module './[campaignId]'`。

- [ ] **Step 6: クーポン画面を実装する**

```tsx
// apps/mobile/src/app/(owner)/campaigns/_layout.tsx
import { Stack } from 'expo-router';

/** クーポン配下の画面タイトル。キーは expo-router のルート名 */
const CAMPAIGN_STACK_TITLES: Record<string, string> = {
  index: 'クーポン',
  '[campaignId]': 'クーポンの編集',
};

export default function OwnerCampaignsStackLayout() {
  return (
    <Stack>
      {Object.entries(CAMPAIGN_STACK_TITLES).map(([name, title]) => (
        <Stack.Screen key={name} name={name} options={{ title }} />
      ))}
    </Stack>
  );
}
```

```tsx
// apps/mobile/src/app/(owner)/campaigns/index.tsx
import { useRouter } from 'expo-router';
import { TicketPercent } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';

import { CampaignRow } from '@/components/owner/campaign-row';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { NEW_ENTITY_ROUTE_SEGMENT } from '@/constants/owner';
import { useCampaigns } from '@/features/owner/queries';
import { useActiveShop } from '@/features/owner/use-active-shop';

const CAMPAIGN_ROUTE_PREFIX = '/campaigns';

export default function OwnerCampaignListScreen() {
  const router = useRouter();
  const activeShop = useActiveShop();
  const campaignsQuery = useCampaigns(activeShop.shopId);

  if (activeShop.shopId === null || campaignsQuery.isLoading) {
    return <Skeleton height={320} testID="campaigns-skeleton" />;
  }
  if (campaignsQuery.isError) {
    return (
      <ErrorState
        description="クーポンを取得できませんでした"
        onRetry={() => void campaignsQuery.refetch()}
      />
    );
  }

  const campaigns = campaignsQuery.data ?? [];

  return (
    <ScrollView contentContainerClassName="gap-3 p-md">
      <Button
        label="クーポンを作る"
        onPress={() => router.push(`${CAMPAIGN_ROUTE_PREFIX}/${NEW_ENTITY_ROUTE_SEGMENT}`)}
        testID="campaigns-new"
      />
      {campaigns.length === 0 ? (
        <EmptyState
          icon={TicketPercent}
          title="クーポンがまだありません"
          description="期間限定の割引やサービス品を登録すると、店舗ページに表示されます"
        />
      ) : (
        <View className="gap-2">
          {campaigns.map((campaign) => (
            <CampaignRow
              key={campaign.id}
              campaign={campaign}
              onPress={() => router.push(`${CAMPAIGN_ROUTE_PREFIX}/${campaign.id}`)}
              testID={`campaign-${campaign.id}`}
            />
          ))}
        </View>
      )}
    </ScrollView>
  );
}
```

```tsx
// apps/mobile/src/app/(owner)/campaigns/[campaignId].tsx
import { zodResolver } from '@hookform/resolvers/zod';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { TicketPercent } from 'lucide-react-native';
import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { campaignInputSchema, GIFT_DISCOUNT_VALUE } from '@meshimap/core';
import type { CampaignInput } from '@meshimap/core';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { DISCOUNT_TYPE_OPTIONS, NEW_ENTITY_ROUTE_SEGMENT } from '@/constants/owner';
import type { DiscountType } from '@/constants/owner';
import {
  useCampaigns,
  useCreateCampaign,
  useDeleteCampaign,
  useUpdateCampaign,
} from '@/features/owner/queries';
import { useActiveShop } from '@/features/owner/use-active-shop';

/** 新規作成時の既定値。期間は空文字にして、必ず入力させる */
const EMPTY_CAMPAIGN: CampaignInput = {
  title: '',
  body: '',
  discountType: 'percent',
  discountValue: 0,
  startsOn: '',
  endsOn: '',
  status: 'draft',
};

export default function OwnerCampaignEditScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ campaignId: string }>();
  const activeShop = useActiveShop();
  const shopId = activeShop.shopId;
  const campaignsQuery = useCampaigns(shopId);
  const createCampaign = useCreateCampaign(shopId ?? '');
  const updateCampaign = useUpdateCampaign(shopId ?? '');
  const deleteCampaign = useDeleteCampaign(shopId ?? '');

  const isNew = params.campaignId === NEW_ENTITY_ROUTE_SEGMENT;
  const existing = (campaignsQuery.data ?? []).find((entry) => entry.id === params.campaignId);

  const form = useForm<CampaignInput>({
    resolver: zodResolver(campaignInputSchema),
    defaultValues: EMPTY_CAMPAIGN,
  });
  const { reset, setValue, watch } = form;
  const discountType = watch('discountType');

  useEffect(() => {
    if (existing !== undefined) {
      const { id: _id, ...input } = existing;
      reset(input);
    }
  }, [existing, reset]);

  if (shopId === null || campaignsQuery.isLoading) {
    return <Skeleton height={320} testID="campaign-edit-skeleton" />;
  }
  if (campaignsQuery.isError) {
    return (
      <ErrorState
        description="クーポンを取得できませんでした"
        onRetry={() => void campaignsQuery.refetch()}
      />
    );
  }
  if (!isNew && existing === undefined) {
    return (
      <EmptyState
        icon={TicketPercent}
        title="クーポンが見つかりません"
        description="他の端末で削除された可能性があります"
        action={{ label: '一覧に戻る', onPress: () => router.back() }}
      />
    );
  }

  const onSelectDiscountType = (value: DiscountType) => {
    setValue('discountType', value);
    // gift は金額を伴わない。切り替えた瞬間に 0 へ戻さないと、
    // campaignInputSchema の refine（gift は 0 固定）で保存できなくなる
    if (value === 'gift') {
      setValue('discountValue', GIFT_DISCOUNT_VALUE);
    }
  };

  const onSubmit = form.handleSubmit((values) => {
    const onSuccess = () => router.back();
    if (isNew) {
      createCampaign.mutate(values, { onSuccess });
      return;
    }
    updateCampaign.mutate({ campaignId: params.campaignId, input: values }, { onSuccess });
  });

  return (
    <ScrollView contentContainerClassName="gap-3 p-md">
      <Controller
        control={form.control}
        name="title"
        render={({ field, fieldState }) => (
          <Input
            label="タイトル"
            value={field.value}
            onChangeText={field.onChange}
            isRequired
            errorMessage={fieldState.error?.message}
            testID="campaign-title"
          />
        )}
      />
      <Controller
        control={form.control}
        name="body"
        render={({ field, fieldState }) => (
          <Input
            label="内容"
            value={field.value}
            onChangeText={field.onChange}
            isMultiline
            isRequired
            errorMessage={fieldState.error?.message}
            testID="campaign-body"
          />
        )}
      />

      <Text className="text-sm text-neutral-700">割引の種類</Text>
      <View className="flex-row gap-2">
        {DISCOUNT_TYPE_OPTIONS.map((option) => (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected: discountType === option.value }}
            onPress={() => onSelectDiscountType(option.value)}
            testID={`campaign-discount-${option.value}`}
          >
            <Text className="text-base text-neutral-900">{option.label}</Text>
          </Pressable>
        ))}
      </View>

      {/* gift は値が 0 固定なので、入力させない（入力できると 422 を招くだけ） */}
      {discountType !== 'gift' && (
        <Controller
          control={form.control}
          name="discountValue"
          render={({ field, fieldState }) => (
            <Input
              label={discountType === 'percent' ? '割引率（%）' : '割引額（円）'}
              value={String(field.value)}
              onChangeText={(text) => field.onChange(text === '' ? Number.NaN : Number(text))}
              isRequired
              errorMessage={fieldState.error?.message}
              testID="campaign-discount-value"
            />
          )}
        />
      )}

      <Controller
        control={form.control}
        name="startsOn"
        render={({ field, fieldState }) => (
          <Input
            label="開始日（YYYY-MM-DD）"
            value={field.value}
            onChangeText={field.onChange}
            isRequired
            placeholder="2026-11-01"
            errorMessage={fieldState.error?.message}
            testID="campaign-starts-on"
          />
        )}
      />
      <Controller
        control={form.control}
        name="endsOn"
        render={({ field, fieldState }) => (
          <Input
            label="終了日（YYYY-MM-DD）"
            value={field.value}
            onChangeText={field.onChange}
            isRequired
            placeholder="2026-11-30"
            errorMessage={fieldState.error?.message}
            testID="campaign-ends-on"
          />
        )}
      />
      {/* 期間の前後関係は campaignInputSchema の refine が見る。
          refine のエラーは endsOn に紐づくので、そのフィールドの errorMessage に出る */}

      <Button
        label="保存"
        onPress={onSubmit}
        isLoading={createCampaign.isPending || updateCampaign.isPending}
      />
      {!isNew && (
        <Button
          label="削除"
          variant="danger"
          onPress={() =>
            deleteCampaign.mutate(params.campaignId, { onSuccess: () => router.back() })
          }
          isLoading={deleteCampaign.isPending}
        />
      )}
    </ScrollView>
  );
}
```

**`campaignInputSchema` の期間 refine には `path: ['endsOn']` が必要である。** これが無いとエラーがオブジェクト全体に付き、`Controller` の `fieldState.error` がどのフィールドにも立たず、画面に何も出ない。Task 8-3 のスキーマ定義に入っていることを確認する（入っていなければそこで足す。メッセージは `'終了日は開始日以降である必要があります'` のまま変えない）。

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/campaigns'`
Expected: PASS（5 + 10 = 15 件）。

- [ ] **Step 7: 店舗ハブにクーポンの区画を足す**

`shop.tsx` の `SHOP_SECTIONS` に 1 行足す。

```tsx
import {
  Armchair,
  Clock,
  ImageIcon,
  MapPin,
  Store,
  TicketPercent,
  UtensilsCrossed,
} from 'lucide-react-native';

const SHOP_SECTIONS = [
  { key: 'basic', title: '基本情報', icon: Store, route: '/shop/basic' },
  { key: 'hours', title: '営業時間', icon: Clock, route: '/shop/hours' },
  { key: 'location', title: '位置', icon: MapPin, route: '/shop/location' },
  { key: 'photos', title: '写真', icon: ImageIcon, route: '/shop/photos' },
  { key: 'menu', title: 'メニュー', icon: UtensilsCrossed, route: '/shop/menu' },
  { key: 'seats', title: '座席', icon: Armchair, route: '/shop/seats' },
  { key: 'campaigns', title: 'クーポン', icon: TicketPercent, route: '/campaigns' },
] as const;
```

**`incompleteByKey` に `campaigns` は足さない。** クーポンは無くても店舗ページは成立するので、「未設定」として急かすものではない。`shop.tsx` の `incompleteByKey` は `Partial<Record<...>>` 型なので、キーを足さなくても型エラーにならない（足す必要が出たときだけ足す）。

`shop.test.tsx` に 1 件足す。

```tsx
it('クーポンの区画からクーポン一覧へ遷移する', async () => {
  mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
  mockedApi.fetchShopHours.mockResolvedValue({ hours: fullWeekHours, closures: [] });
  mockedApi.fetchShopPhotos.mockResolvedValue([]);
  mockedApi.fetchShopSeats.mockResolvedValue({
    seatCount: 12,
    hasCounter: true,
    hasPrivateRoom: false,
    smokingPolicy: 'no-smoking',
  });
  mockedApi.fetchMenuTree.mockResolvedValue({ categories: [] });
  renderScreen();
  await waitFor(() => expect(screen.getByTestId('shop-section-campaigns')).toBeTruthy());
  fireEvent.press(screen.getByTestId('shop-section-campaigns'));
  expect(mockPush).toHaveBeenCalledWith('/campaigns');
});

it('クーポンは未設定でも「未設定」と出さない（無くても店舗ページは成立する）', async () => {
  mockedApi.fetchOwnedShops.mockResolvedValue([shop]);
  mockedApi.fetchShopHours.mockResolvedValue({ hours: fullWeekHours, closures: [] });
  mockedApi.fetchShopPhotos.mockResolvedValue([]);
  mockedApi.fetchShopSeats.mockResolvedValue({
    seatCount: 12,
    hasCounter: true,
    hasPrivateRoom: false,
    smokingPolicy: 'no-smoking',
  });
  mockedApi.fetchMenuTree.mockResolvedValue({ categories: [] });
  renderScreen();
  await waitFor(() => expect(screen.getByTestId('shop-section-campaigns')).toBeTruthy());
  expect(screen.queryByLabelText('クーポン、未設定')).toBeNull();
});
```

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/(tabs)/shop.test.tsx'`
Expected: PASS（Task 8-18 の分 + 2 件）。

- [ ] **Step 8: オンボーディング画面のテストを書く**

```tsx
// apps/mobile/src/app/(owner)/onboarding/status.test.tsx
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { createQueryWrapper } from '@/features/owner/testing/query-wrapper';

import OwnerOnboardingStatusScreen from './status';

jest.mock('@/features/owner/api');
const mockedApi = jest.requireMock<typeof import('@/features/owner/api')>('@/features/owner/api');
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const application = (status: string, reviewNote: string | null) => ({
  id: 'app_1',
  status,
  reviewNote,
  documents: [],
  updatedAt: '2026-09-15T00:00:00.000Z',
});

function renderScreen() {
  const { wrapper: Wrapper } = createQueryWrapper();
  return render(<OwnerOnboardingStatusScreen />, { wrapper: Wrapper });
}

describe('申請状況画面', () => {
  it('未申請なら「まだ申請していません」と出し、書類提出へ進める', async () => {
    mockedApi.fetchApplication.mockResolvedValue(null);
    renderScreen();
    await waitFor(() => expect(screen.getByText('まだ申請していません')).toBeTruthy());
    fireEvent.press(screen.getByText('書類を提出する'));
    expect(mockPush).toHaveBeenCalledWith('/onboarding/apply');
  });

  it('審査中は状態を出し、書類提出の導線を出さない', async () => {
    mockedApi.fetchApplication.mockResolvedValue(application('pending', null));
    renderScreen();
    await waitFor(() => expect(screen.getByText('審査中')).toBeTruthy());
    expect(screen.queryByText('書類を提出する')).toBeNull();
  });

  it('差し戻しは運営メモを出し、再提出へ進める', async () => {
    mockedApi.fetchApplication.mockResolvedValue(application('returned', '営業許可証が読めません'));
    renderScreen();
    await waitFor(() => expect(screen.getByText('差し戻し')).toBeTruthy());
    expect(screen.getByText('営業許可証が読めません')).toBeTruthy();
    fireEvent.press(screen.getByText('書類を提出する'));
    expect(mockPush).toHaveBeenCalledWith('/onboarding/apply');
  });

  it('却下は運営メモを出すが、再提出はできない', async () => {
    mockedApi.fetchApplication.mockResolvedValue(application('rejected', '住所が確認できません'));
    renderScreen();
    await waitFor(() => expect(screen.getByText('却下')).toBeTruthy());
    expect(screen.getByText('住所が確認できません')).toBeTruthy();
    expect(screen.queryByText('書類を提出する')).toBeNull();
  });

  it('審査中は運営メモを出さない（内部の判断材料を見せない）', async () => {
    mockedApi.fetchApplication.mockResolvedValue(application('pending', '確認中のメモ'));
    renderScreen();
    await waitFor(() => expect(screen.getByText('審査中')).toBeTruthy());
    expect(screen.queryByText('確認中のメモ')).toBeNull();
  });

  it('承認済みは運営メモを出さない', async () => {
    mockedApi.fetchApplication.mockResolvedValue(application('approved', '問題なし'));
    renderScreen();
    await waitFor(() => expect(screen.getByText('承認済み')).toBeTruthy());
    expect(screen.queryByText('問題なし')).toBeNull();
  });

  it('取得に失敗したら再試行できる', async () => {
    mockedApi.fetchApplication.mockRejectedValue(new Error('落ちた'));
    renderScreen();
    await waitFor(() => expect(screen.getByText('再試行')).toBeTruthy());
    mockedApi.fetchApplication.mockResolvedValue(application('pending', null));
    fireEvent.press(screen.getByText('再試行'));
    await waitFor(() => expect(screen.getByText('審査中')).toBeTruthy());
  });
});
```

```tsx
// apps/mobile/src/app/(owner)/onboarding/apply.test.tsx
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { createQueryWrapper } from '@/features/owner/testing/query-wrapper';

import OwnerOnboardingApplyScreen from './apply';

jest.mock('@/features/owner/api');
jest.mock('@/features/owner/pick-image');
const mockedApi = jest.requireMock<typeof import('@/features/owner/api')>('@/features/owner/api');
const mockedPick = jest.requireMock<typeof import('@/features/owner/pick-image')>(
  '@/features/owner/pick-image',
);
const mockBack = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack }) }));

const application = (status: string, documents: { kind: string; r2Key: string }[]) => ({
  id: 'app_1',
  status,
  reviewNote: null,
  documents,
  updatedAt: '2026-09-15T00:00:00.000Z',
});

const source = { uri: 'file:///tmp/a.jpg', mimeType: 'image/jpeg', fileName: 'a.jpg' };

function renderScreen() {
  const { wrapper: Wrapper } = createQueryWrapper();
  return render(<OwnerOnboardingApplyScreen />, { wrapper: Wrapper });
}

describe('書類提出画面', () => {
  it('提出済みの書類の種類を一覧に出す', async () => {
    mockedApi.fetchApplication.mockResolvedValue(
      application('returned', [{ kind: 'business-license', r2Key: 'apps/app_1/a.jpg' }]),
    );
    renderScreen();
    await waitFor(() => expect(screen.getByText('営業許可証')).toBeTruthy());
  });

  it('書類が 0 件なら空状態を出す', async () => {
    mockedApi.fetchApplication.mockResolvedValue(application('returned', []));
    renderScreen();
    await waitFor(() => expect(screen.getByText('提出済みの書類はありません')).toBeTruthy());
  });

  it('選択肢に無い kind は生の値をそのまま出す', async () => {
    // サーバは kind を非空文字列としか検証しないので、一覧外の値が入り得る
    mockedApi.fetchApplication.mockResolvedValue(
      application('returned', [{ kind: 'unknown-kind', r2Key: 'apps/app_1/c.jpg' }]),
    );
    renderScreen();
    await waitFor(() => expect(screen.getByText('unknown-kind')).toBeTruthy());
  });

  it('種類を選んで追加すると uploadApplicationDocument を呼ぶ', async () => {
    mockedApi.fetchApplication.mockResolvedValue(application('returned', []));
    mockedPick.pickShopImage.mockResolvedValue(source);
    mockedApi.uploadApplicationDocument.mockResolvedValue(
      application('returned', [{ kind: 'identity', r2Key: 'apps/app_1/b.jpg' }]),
    );
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('document-kind-identity')).toBeTruthy());
    fireEvent.press(screen.getByTestId('document-kind-identity'));
    fireEvent.press(screen.getByText('書類を追加'));
    await waitFor(() =>
      expect(mockedApi.uploadApplicationDocument).toHaveBeenCalledWith('identity', source),
    );
  });

  it('画像選択をやめたらアップロードしない', async () => {
    mockedApi.fetchApplication.mockResolvedValue(application('returned', []));
    mockedPick.pickShopImage.mockResolvedValue(null);
    renderScreen();
    await waitFor(() => expect(screen.getByText('書類を追加')).toBeTruthy());
    fireEvent.press(screen.getByText('書類を追加'));
    await waitFor(() => expect(mockedPick.pickShopImage).toHaveBeenCalledTimes(1));
    expect(mockedApi.uploadApplicationDocument).not.toHaveBeenCalled();
  });

  it('書類が 1 件も無いと再提出できない', async () => {
    mockedApi.fetchApplication.mockResolvedValue(application('returned', []));
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('resubmit')).toBeTruthy());
    expect(screen.getByTestId('resubmit').props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });

  it('書類があれば再提出でき、メモを一緒に送る', async () => {
    mockedApi.fetchApplication.mockResolvedValue(
      application('returned', [{ kind: 'business-license', r2Key: 'apps/app_1/a.jpg' }]),
    );
    mockedApi.resubmitApplication.mockResolvedValue(application('pending', []));
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('resubmit-note')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('resubmit-note'), '撮り直しました');
    fireEvent.press(screen.getByTestId('resubmit'));
    await waitFor(() =>
      expect(mockedApi.resubmitApplication).toHaveBeenCalledWith('撮り直しました'),
    );
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
  });

  it('審査中の申請は書類を足せない（差し替えは運営の手間になる）', async () => {
    mockedApi.fetchApplication.mockResolvedValue(application('pending', []));
    renderScreen();
    await waitFor(() => expect(screen.getByText('審査中は書類を変更できません')).toBeTruthy());
    expect(screen.queryByText('書類を追加')).toBeNull();
  });

  it('アップロードに失敗したらエラー文言を出す', async () => {
    mockedApi.fetchApplication.mockResolvedValue(application('returned', []));
    mockedPick.pickShopImage.mockResolvedValue(source);
    mockedApi.uploadApplicationDocument.mockRejectedValue(new Error('落ちた'));
    renderScreen();
    await waitFor(() => expect(screen.getByText('書類を追加')).toBeTruthy());
    fireEvent.press(screen.getByText('書類を追加'));
    await waitFor(() =>
      expect(screen.getByText('書類をアップロードできませんでした')).toBeTruthy(),
    );
  });
});
```

- [ ] **Step 9: オンボーディング画面を実装する**

```tsx
// apps/mobile/src/app/(owner)/onboarding/_layout.tsx
import { Stack } from 'expo-router';

/** オンボーディング配下の画面タイトル。キーは expo-router のルート名 */
const ONBOARDING_STACK_TITLES: Record<string, string> = {
  status: '申請状況',
  apply: '書類の提出',
};

export default function OwnerOnboardingStackLayout() {
  return (
    <Stack>
      {Object.entries(ONBOARDING_STACK_TITLES).map(([name, title]) => (
        <Stack.Screen key={name} name={name} options={{ title }} />
      ))}
    </Stack>
  );
}
```

```tsx
// apps/mobile/src/app/(owner)/onboarding/status.tsx
import { useRouter } from 'expo-router';
import { ScrollView, Text } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { APPLICATION_STATUS_LABELS } from '@/constants/owner';
import { useApplication } from '@/features/owner/queries';
import { formatReviewDate } from '@/lib/format-date';

const APPLY_ROUTE = '/onboarding/apply';
const NOT_APPLIED_MESSAGE = 'まだ申請していません';
const APPLY_LABEL = '書類を提出する';

/** 運営メモを見せてよい状態。審査中・承認済みでは内部の判断材料を出さない */
const NOTE_VISIBLE_STATUSES = ['returned', 'rejected'] as const;

/** 書類提出へ進める状態。承認済み・却下・審査中からは進めない */
const APPLY_VISIBLE_STATUSES = ['returned'] as const;

export default function OwnerOnboardingStatusScreen() {
  const router = useRouter();
  const applicationQuery = useApplication();

  if (applicationQuery.isLoading) {
    return <Skeleton height={200} testID="application-skeleton" />;
  }
  if (applicationQuery.isError) {
    return (
      <ErrorState
        description="申請状況を取得できませんでした"
        onRetry={() => void applicationQuery.refetch()}
      />
    );
  }

  const application = applicationQuery.data ?? null;

  if (application === null) {
    return (
      <ScrollView contentContainerClassName="gap-3 p-md">
        <Text className="text-base text-neutral-900">{NOT_APPLIED_MESSAGE}</Text>
        <Text className="text-sm text-neutral-600">
          営業許可証などの書類を提出すると、運営が確認したうえで店舗を公開できるようになります
        </Text>
        <Button label={APPLY_LABEL} onPress={() => router.push(APPLY_ROUTE)} />
      </ScrollView>
    );
  }

  const isNoteVisible = NOTE_VISIBLE_STATUSES.some((status) => status === application.status);
  const isApplyVisible = APPLY_VISIBLE_STATUSES.some((status) => status === application.status);

  return (
    <ScrollView contentContainerClassName="gap-3 p-md">
      <Card>
        <Text className="text-lg text-neutral-900">
          {APPLICATION_STATUS_LABELS[application.status]}
        </Text>
        <Text className="mt-1 text-xs text-neutral-500">
          最終更新 {formatReviewDate(application.updatedAt)}
        </Text>
      </Card>
      {isNoteVisible && application.reviewNote !== null && (
        <Card testID="review-note">
          <Text className="text-sm text-neutral-700">運営からのコメント</Text>
          <Text className="mt-1 text-base text-neutral-900">{application.reviewNote}</Text>
        </Card>
      )}
      {isApplyVisible && <Button label={APPLY_LABEL} onPress={() => router.push(APPLY_ROUTE)} />}
    </ScrollView>
  );
}
```

```tsx
// apps/mobile/src/app/(owner)/onboarding/apply.tsx
import { useRouter } from 'expo-router';
import { FileText } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { DocumentKind } from '@meshimap/core';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { DOCUMENT_KIND_OPTIONS, RESUBMITTABLE_APPLICATION_STATUSES } from '@/constants/owner';
import { pickShopImage } from '@/features/owner/pick-image';
import {
  useApplication,
  useResubmitApplication,
  useUploadApplicationDocument,
} from '@/features/owner/queries';

const UPLOAD_ERROR_MESSAGE = '書類をアップロードできませんでした';
const LOCKED_MESSAGE = '審査中は書類を変更できません';
const ADD_LABEL = '書類を追加';

/** 既定で選ばれている書類の種類。最初に出す必要があるものを既定にする */
const DEFAULT_DOCUMENT_KIND: DocumentKind = 'business-license';

export default function OwnerOnboardingApplyScreen() {
  const router = useRouter();
  const applicationQuery = useApplication();
  const uploadDocument = useUploadApplicationDocument();
  const resubmit = useResubmitApplication();
  const [kind, setKind] = useState<DocumentKind>(DEFAULT_DOCUMENT_KIND);
  const [note, setNote] = useState('');

  if (applicationQuery.isLoading) {
    return <Skeleton height={320} testID="apply-skeleton" />;
  }
  if (applicationQuery.isError) {
    return (
      <ErrorState
        description="申請を取得できませんでした"
        onRetry={() => void applicationQuery.refetch()}
      />
    );
  }

  const application = applicationQuery.data ?? null;
  const documents = application?.documents ?? [];
  // 未申請（null）と差し戻しのときだけ編集できる。審査中・承認済み・却下は読み取り専用
  const isEditable =
    application === null ||
    RESUBMITTABLE_APPLICATION_STATUSES.some((status) => status === application.status);

  const onAdd = async () => {
    const source = await pickShopImage();
    if (source === null) {
      return;
    }
    uploadDocument.mutate({ kind, source });
  };

  return (
    <ScrollView contentContainerClassName="gap-3 p-md">
      {documents.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="提出済みの書類はありません"
          description="営業許可証と本人確認書類を撮影して追加してください"
        />
      ) : (
        <View className="gap-2">
          {documents.map((document) => (
            <Card key={document.r2Key} padding="sm" testID={`document-${document.r2Key}`}>
              <Text className="text-base text-neutral-900">
                {DOCUMENT_KIND_OPTIONS.find((option) => option.value === document.kind)?.label ??
                  document.kind}
              </Text>
            </Card>
          ))}
        </View>
      )}

      {isEditable ? (
        <>
          <Text className="text-sm text-neutral-700">書類の種類</Text>
          <View className="flex-row gap-3">
            {DOCUMENT_KIND_OPTIONS.map((option) => (
              <Pressable
                key={option.value}
                accessibilityRole="radio"
                accessibilityState={{ selected: kind === option.value }}
                onPress={() => setKind(option.value)}
                testID={`document-kind-${option.value}`}
              >
                <Text className="text-base text-neutral-900">{option.label}</Text>
              </Pressable>
            ))}
          </View>
          <Button
            label={ADD_LABEL}
            onPress={() => void onAdd()}
            isLoading={uploadDocument.isPending}
          />
          {uploadDocument.isError && (
            <Text className="text-sm text-red-500">{UPLOAD_ERROR_MESSAGE}</Text>
          )}

          <Input
            label="運営への連絡（任意）"
            value={note}
            onChangeText={setNote}
            isMultiline
            testID="resubmit-note"
          />
          <Button
            label="この内容で提出する"
            onPress={() => resubmit.mutate(note, { onSuccess: () => router.back() })}
            // 書類ゼロで提出させると、運営が確認するものが無いまま審査待ちが 1 件増える
            isDisabled={documents.length === 0}
            isLoading={resubmit.isPending}
            testID="resubmit"
          />
        </>
      ) : (
        <Text className="text-sm text-neutral-600">{LOCKED_MESSAGE}</Text>
      )}
    </ScrollView>
  );
}
```

この 2 フック自体は Task 8-15 で作ってある。ここでは 2 点だけ直す。

**1. `useResubmitApplication` の無効化キーを 2 本にする。** Task 8-15 の表では `ownerQueryKeys.application()` だけだったが、再提出が承認されると店舗が増えるので店舗一覧も古くなる。

```ts
export function useResubmitApplication(): UseMutationResult<ShopApplication, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (note: string) => resubmitApplication(note),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ownerQueryKeys.application() });
      // 承認されると店舗が増えるので、店舗一覧も取り直す
      queryClient.invalidateQueries({ queryKey: ownerQueryKeys.shops() });
    },
  });
}
```

`apps/mobile/src/features/owner/queries.test.tsx` の `useResubmitApplication` の `describe` に 1 件足す。

```tsx
it('再提出に成功したら application と店舗一覧の両方を無効化する', async () => {
  // 承認されると (owner) で扱える店舗が増えるので、application だけでは足りない
  mockedApi.resubmitApplication.mockResolvedValue({
    id: 'app_1',
    status: 'pending',
    reviewNote: null,
    documents: [],
    updatedAt: '2026-09-15T00:00:00.000Z',
  });
  const { wrapper, client } = createQueryWrapper();
  const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
  const { result } = renderHook(() => useResubmitApplication(), { wrapper });

  result.current.mutate('撮り直しました');

  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ownerQueryKeys.application() });
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ownerQueryKeys.shops() });
});
```

**2. `api.ts` の `uploadApplicationDocument` の第 1 引数を `string` から `DocumentKind` に狭める。** Step 1 で選択肢が決まったので、ここで型でも縛れるようになる。`useUploadApplicationDocument` の変数型（Task 8-15 で `{ kind: DocumentKind; source: PhotoUploadSource }` と決めてある）はそのままで通る。

Run: `npm run test -w @meshimap/mobile -- 'src/app/(owner)/onboarding'`
Expected: PASS（7 + 9 = 16 件）。

- [ ] **Step 10: わざと壊して検証が効いていることを確認する**

`status.tsx` の `NOTE_VISIBLE_STATUSES` に `'pending'` を足す。
Expected: FAIL。「審査中は運営メモを出さない」が落ちる。

次に `apply.tsx` の `isDisabled={documents.length === 0}` を消す。
Expected: FAIL。「書類が 1 件も無いと再提出できない」が落ちる。

次に `[campaignId].tsx` の `onSelectDiscountType` から `setValue('discountValue', GIFT_DISCOUNT_VALUE)` を消す。
Expected: FAIL。「gift に切り替えると割引額が 0 に戻る」が落ちる（`discountValue` が 10 のまま送られるか、refine で弾かれて `updateCampaign` が呼ばれない）。

次に `campaign-row.tsx` の `formatDiscount` の `case 'gift'` を `return \`${formatPriceYen(campaign.discountValue)} オフ\`` に変える。
Expected: FAIL。「gift は金額を出さず「サービス品」と出す」が落ちる。

次に `campaigns/index.tsx` の `NEW_ENTITY_ROUTE_SEGMENT` をリテラル `'new'` に置き換える。
Expected: PASS のまま落ちない。値が同じなので出力が変わらない変異である。**これは「出力を変えない最適化」に当たるので、値そのものを縛るテストで殺す。** そのテストは Task 8-15 で既に `src/constants/owner.test.ts` に書いた「新規作成を表す URL セグメントは new」であり、**ここで新しく足す必要はない（既にある）。** 足りていることを確認するために、逆向きに壊して両方が落ちることを見る。

`constants/owner.ts` の `NEW_ENTITY_ROUTE_SEGMENT` を `'create'` に変える。
Expected: FAIL。`src/constants/owner.test.ts` の「新規作成を表す URL セグメントは new」と、`campaigns/index.test.tsx` の「「クーポンを作る」は new へ遷移する」の 2 本が落ちる。

**6 つとも確認したら元に戻し、緑になることを確認する。**

- [ ] **Step 11: カバレッジ・型・lint を通してコミット**

Run: `npm run test -w @meshimap/mobile && npm run typecheck -w @meshimap/mobile && npm run lint`
Expected: すべて成功、カバレッジ 100%。

```bash
git add 'apps/mobile/src/app/(owner)' apps/mobile/src/components/owner apps/mobile/src/constants/owner.ts apps/mobile/src/constants/owner.test.ts apps/mobile/src/features/owner
git commit -m "feat(mobile): クーポン管理とオンボーディング（書類提出・再提出）を追加"
```

---

## Task 8-23: 総点検（定数の突合・ルート表の照合・変異テスト）

**Files:**

- Create: `apps/api/src/db/owner-constants-parity.test.ts`
- Modify: `apps/api/src/routes/permission-matrix.test.ts`（Task 8-14 で足した行が実装と合っているかを確認する。**新しい突合テストは作らない**）
- Modify: `apps/api/stryker.config.json`（`mutate` に `src/routes/owner/**/*.ts` と `src/repositories/owner-*.ts` が含まれることを確認し、含まれていなければ追加）
- Test: 新規 1 本 + 既存すべて

**突合テストを `apps/api` に置く理由：** マイグレーション本文を `readFileSync` で読む必要があり、既存の `apps/api/src/db/constants-parity.test.ts` が同じことを Vitest（node 実行）でやっている（実ファイルで確認済み）。`apps/mobile` の Jest は jest-expo プリセットで動くので、`node:fs` を使う突合テストはそこに置かない。

**Interfaces:**

- Consumes: Phase 8 で作ったすべての定数・ルート・スキーマ
- Produces: なし（検証だけのタスク。後続フェーズが依存する新しい値は作らない）

### このタスクがやること

Phase 8 は「`packages/core` のスキーマ」「`apps/api/src/db/constants.ts`」「D1 の CHECK 制約」「モバイルの `z.enum` の写し」の 4 か所に同じ値が現れる。型では繋がっていない組み合わせがあるので、**ズレたら落ちるテストを置いて閉じる。**

突合する対象は以下の 6 組。

| TypeScript 側の値                                        | 突合相手（CHECK 制約名）                       | どのマイグレーション                         | ズレたときに起きること                 |
| -------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------- | -------------------------------------- |
| `MENU_ITEM_NAME_MAX`（core、Task 8-3）                   | `ck_menu_items_name_length`（`<= 100`）        | `0000_init.sql`（既存）                      | 画面と API は通すのに D1 が 500 を返す |
| `MENU_ITEM_DESCRIPTION_MAX`（core、Task 8-3）            | `ck_menu_items_description_length`（`<= 500`） | `0000_init.sql`（既存）                      | 同上                                   |
| `REVIEW_REPLY_BODY_MAX`（core、Task 8-3）                | `ck_review_replies_body_length`（`<= 1000`）   | `0000_init.sql`（既存）                      | 同上                                   |
| `APPLICATION_STATUSES`（`src/db/constants.ts`、Phase 3） | `ck_shop_applications_status`                  | `0000_init.sql`（既存）                      | 再提出で `pending` に戻せず 500        |
| `DISCOUNT_TYPES`（`src/db/constants.ts`、Task 8-1）      | `ck_campaigns_discount_type`                   | `0002_campaigns_and_daily_stats.sql`（新規） | 画面に出る選択肢が保存できない         |
| `CAMPAIGN_STATUSES`（`src/db/constants.ts`、Task 8-1）   | `ck_campaigns_status`                          | `0002_campaigns_and_daily_stats.sql`（新規） | 同上                                   |

**上の表のうち `0000_init.sql` 側の制約名と値は、実際にファイルを開いて確認した実測値である**（`ck_menu_items_name_length` は `<= 100`、`ck_menu_items_description_length` は `<= 500`、`ck_review_replies_body_length` は `<= 1000`、`ck_shop_applications_status` は `IN ('pending', 'approved', 'rejected', 'returned')`。いずれも `apps/api/migrations/0000_init.sql` の `menu_items` / `review_replies` / `shop_applications` のブロック内）。`0002_campaigns_and_daily_stats.sql` はまだ存在しないので、そちらは **未確認**（Task 8-1 で生成される）。

既存の `apps/api/src/db/constants-parity.test.ts` が同じ手口（マイグレーション本文を読んで突き合わせる）を使っているので、**その仕組みをそのまま使う。新しい突合の書き方を発明しない。** とくに、パスの作り方を `dirname(fileURLToPath(import.meta.url))` にそろえること。既存ファイルには「`readFileSync(new URL(...))` と書けないのは、この tsconfig のグローバル `URL` が `@cloudflare/workers-types` のもので、Node の `fs` が要求する `node:url` の `URL` と別物として扱われるため（TS2769 を実測）」というコメントがある（実ファイルで確認済み）。

**モバイル側の写し**（`features/owner/types.ts` の `campaignSchema` / `shopApplicationSchema` に書いた `z.enum([...])`）は、`apps/api` を import できないので値で突き合わせられない。**代わりに、この突合テストが SQL 側を正として固定し、モバイルの写しがズレたときは Task 8-14 のルートテスト（実 SQL に到達する）が 422 / 500 で落ちる。** この二段構えで閉じる。

- [ ] **Step 1: 定数とマイグレーションの突合テストを書く**

```ts
// apps/api/src/db/owner-constants-parity.test.ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MENU_ITEM_DESCRIPTION_MAX,
  MENU_ITEM_NAME_MAX,
  REVIEW_REPLY_BODY_MAX,
} from '@meshimap/core';
import { describe, expect, it } from 'vitest';

import { APPLICATION_STATUSES, CAMPAIGN_STATUSES, DISCOUNT_TYPES } from './constants';

// パスの作り方は既存の constants-parity.test.ts にそろえる（理由は同ファイルのコメント参照）
const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(CURRENT_DIR, '..', '..', 'migrations');
const initSql = readFileSync(join(MIGRATIONS_DIR, '0000_init.sql'), 'utf8');
const ownerSql = readFileSync(join(MIGRATIONS_DIR, '0002_campaigns_and_daily_stats.sql'), 'utf8');

/** 名前付き CHECK 制約の本文から `<= N` の N を取り出す */
function readLengthLimit(sql: string, constraintName: string): number {
  const pattern = new RegExp(`CONSTRAINT "${constraintName}" CHECK\\([^)]*\\) <= (\\d+)\\)`, 'u');
  const matched = pattern.exec(sql);
  if (matched?.[1] === undefined) {
    throw new Error(`制約 ${constraintName} が見つかりません`);
  }
  return Number(matched[1]);
}

/** 名前付き CHECK 制約の `IN (...)` に並ぶ文字列リテラルを、書かれている順で取り出す */
function readEnumValues(sql: string, constraintName: string): readonly string[] {
  const pattern = new RegExp(`CONSTRAINT "${constraintName}" CHECK\\([^)]*IN \\(([^)]*)\\)`, 'u');
  const matched = pattern.exec(sql);
  if (matched?.[1] === undefined) {
    throw new Error(`制約 ${constraintName} が見つかりません`);
  }
  return [...matched[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1] ?? '');
}

describe('Phase 8 で使う定数と D1 の CHECK 制約が一致している', () => {
  it('メニュー名の上限が一致する', () => {
    expect(readLengthLimit(initSql, 'ck_menu_items_name_length')).toBe(MENU_ITEM_NAME_MAX);
  });

  it('メニュー説明の上限が一致する', () => {
    expect(readLengthLimit(initSql, 'ck_menu_items_description_length')).toBe(
      MENU_ITEM_DESCRIPTION_MAX,
    );
  });

  it('レビュー返信の上限が一致する', () => {
    expect(readLengthLimit(initSql, 'ck_review_replies_body_length')).toBe(REVIEW_REPLY_BODY_MAX);
  });

  it('申請状態の集合と並びが一致する', () => {
    expect(readEnumValues(initSql, 'ck_shop_applications_status')).toStrictEqual([
      ...APPLICATION_STATUSES,
    ]);
  });

  it('割引種別の集合と並びが一致する', () => {
    expect(readEnumValues(ownerSql, 'ck_campaigns_discount_type')).toStrictEqual([
      ...DISCOUNT_TYPES,
    ]);
  });

  it('クーポン状態の集合と並びが一致する', () => {
    expect(readEnumValues(ownerSql, 'ck_campaigns_status')).toStrictEqual([...CAMPAIGN_STATUSES]);
  });
});
```

**`toStrictEqual` で並び順まで見るのは意図した厳しさである。** Drizzle は `inValues(...)` に渡した配列の順でリテラルを並べるので、片方だけ並べ替えたことも検出できる。

**正規表現が SQL 全体を舐めないよう、`CONSTRAINT "名前" CHECK(` から始めている。** 名前を省いた無名 CHECK は捕まえられないので、Task 8-1 で `0002` を書くときに `check('ck_campaigns_discount_type', ...)` のように必ず名前を付ける（Task 8-1 の Drizzle スキーマは既にそう書いてある）。

Run: `npm run test -w @meshimap/api -- owner-constants-parity`
Expected: FAIL。`0002_campaigns_and_daily_stats.sql` がまだ無ければ `ENOENT`、制約名が無ければ「制約 ... が見つかりません」。

- [ ] **Step 2: マイグレーションと定数を直してテストを通す**

Task 8-1 で生成した `apps/api/migrations/0002_campaigns_and_daily_stats.sql` を開き、`campaigns` の 2 つの CHECK 制約に `ck_campaigns_discount_type` / `ck_campaigns_status` という名前が付いていることを確認する。付いていなければ Drizzle スキーマ側に `check()` の第 1 引数として名前を足し、マイグレーションを生成し直す。

`MENU_ITEM_NAME_MAX` / `MENU_ITEM_DESCRIPTION_MAX` / `REVIEW_REPLY_BODY_MAX` は `0000_init.sql` の実値（100 / 500 / 1000）に合わせる。**Task 8-3 の core 側の定数はこの 3 つと同じ値で書かれているので、ここで値を変える必要は無いはずである。** もし落ちたら、変えるのは core の定数のほうで、マイグレーションではない（`0000_init.sql` は適用済みで、後から書き換えられない）。

Run: `npm run test -w @meshimap/api -- owner-constants-parity`
Expected: PASS（6 件）。

- [ ] **Step 3: 既存のルート突合テストが Phase 8 の 32 本を覆っていることを確認する**

**新しい突合テストは作らない。** Phase 4 Task 4-14 が `apps/api/src/routes/permission-matrix.test.ts` の末尾に「ルート表と実装の突合」という `describe` を既に持っている。**Phase 7 がここに委譲の仕組みを足しているので、Phase 8 が見る実物は次の 5 つである**（実物 620 行付近を開いて確認すること）。

- `declaredRoutePatterns()` … `app.routes` から `ALL /*`（ミドルウェア）と `AUTH_BASE_PATH` 配下（Better Auth）を除き、`` `${method} ${path}` `` に整形して重複を潰し、**ソートして**返す
- `EXPECTED_ROUTE_PATTERNS` … 権限マトリクスが責任を持つルートパターンの一覧（Phase 4 時点で 10 本、Phase 7 後は 19 本）。`declaredRoutePatterns()` と `toEqual` で比較されるので**昇順である必要がある**
- `DELEGATED_ROUTE_PATTERNS`（Phase 7 が追加） … 主体ごとの総当たりを別ファイルに委ねたルート。予約系 9 本。**Phase 8 はここに足さない**
- `DELEGATABLE_PATH_PATTERN`（Phase 7 が追加） … 委譲を許すパスの形 `/^\/(reservation-slots|reservations|owner\/reservations)(\/|$)/`。**Phase 8 はここにも足さない**
- 4 つの `it` … 「走査対象のエンドポイントが 1 本以上ある」「app に登録されたエンドポイントは N 本で、想定どおりの並びである」「権限マトリクスは app のエンドポイントを 1 本残らず覆っている」（`ENDPOINT_CASES` の `routePattern` に `DELEGATED_ROUTE_PATTERNS` を混ぜて重複排除して比較する）「委譲しているのは予約系だけで、予約系は 1 本残らず委譲されている」

Task 8-14 の Step 16 / Step 17 で、`ENDPOINT_CASES` に 32 行、`EXPECTED_ROUTE_PATTERNS` に 32 本を足した。ここではそれが実装と一致しているかを走らせて確かめる。

Run: `npm run test -w @meshimap/api -- permission-matrix`
Expected: PASS。**本数は Phase 7 を済ませているかで変わる。**

| 着手時点                   | `EXPECTED_ROUTE_PATTERNS` | `DELEGATED_ROUTE_PATTERNS` |
| -------------------------- | ------------------------: | -------------------------: |
| Phase 4 のみ               |                     10 本 |                       無い |
| Phase 7 後（予約 9 本）    |                     19 本 |                       9 本 |
| **Phase 8 後（本タスク）** |      **51 本**（19 + 32） |             **9 本のまま** |

フェーズ順（7 → 8）どおりに進めていれば **51 本**。Phase 7 を飛ばしている場合だけ 42 本になる。
**Phase 8 が決めているのは増分 32 だけで、土台の本数ではない。**
着手前に実物 `apps/api/src/routes/permission-matrix.test.ts` を開いて現在の本数を数え、
「実物の本数 + 32」に読み替えること。

**委譲側は増えない。** Phase 8 の 32 本は `ENDPOINT_CASES` が主体ごとの総当たりを直接持つので、`DELEGATED_ROUTE_PATTERNS` は Phase 7 が入れた予約系 9 本のまま、`DELEGATABLE_PATH_PATTERN` も予約系 3 語のままである。ここが 9 本以外になっていたら Task 8-14 で触ってはいけない行を触っている。

FAIL したときの読み方は次の 3 通りしかない。

| 落ち方                                                                      | 意味                                                                         | 直し方                                                                                                                                                  |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `declaredRoutePatterns()` にあるのに `EXPECTED_ROUTE_PATTERNS` に無い       | ルートを実装したが表に足していない                                           | `EXPECTED_ROUTE_PATTERNS` と `ENDPOINT_CASES` の両方に足す。`ENDPOINT_CASES` には 4 ロールぶんの期待値を必ず埋める                                      |
| `EXPECTED_ROUTE_PATTERNS` にあるのに `declaredRoutePatterns()` に無い       | 表にはあるがルートが未実装                                                   | ルートを実装する。**表から消すのは、そのエンドポイントを Phase 8 のスコープから外すと決めたときだけで、そのときは本計画書の権限マトリクス表からも消す** |
| 「委譲しているのは予約系だけで、予約系は 1 本残らず委譲されている」が落ちる | Phase 8 が `DELEGATED_ROUTE_PATTERNS` か `DELEGATABLE_PATH_PATTERN` を触った | 触った行を元に戻す。**Phase 8 はこの 2 つを変更しない**（「権限マトリクス」節の「Phase 8 は委譲しない」を参照）                                         |

- [ ] **Step 4: 覆えていない行があれば直す**

Step 3 の表に従って直し、緑にする。

**`ENDPOINT_CASES` の要素は `routePattern` というフィールドでルートを表す**（Phase 4 の実装）。`method` と `path` に分かれてはいないので、行を足すときは既存行の形をそのまま真似ること。

Run: `npm run test -w @meshimap/api -- permission-matrix`
Expected: PASS。

- [ ] **Step 5: 設計書の記述が実装と合っていることを確認する**

`docs/design.md` §6 のテーブル一覧への `campaigns` / `shop_daily_stats` の追記は **Task 8-1 で済んでいる**（Task 8-1 のタイトルが「データモデル追加と設計書の同期」）。ここでは二重に書き足さず、**書かれている内容が実装と一致しているか**だけを見る。

確認する点は 3 つ。

1. 列名が Drizzle スキーマと一致しているか（`shop_daily_stats.stat_date` など、途中で名前を変えていないか）
2. §5.1 の `(owner)/` 画面一覧に、Task 8-22 で足した `campaigns/index` / `campaigns/[campaignId]` が載っているか。無ければ 2 行足す
3. §5.1 の店舗ハブの説明に「クーポン」区画が含まれているか

ズレていた箇所だけを直す。**それ以外の行は触らない。** 他フェーズの担当者が同じファイルを編集している可能性がある。

- [ ] **Step 6: 全テストと型検査を通す**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: すべて成功。

カバレッジが 100% でない場合、**到達していない行を消すか、到達するテストを足すかのどちらかで対応する。** カバレッジの除外設定を足して回避しない。

- [ ] **Step 7: 変異テストを走らせる**

Run: `npm run test:mutation -w @meshimap/api`
Expected: 変異スコアが `break: 85` を上回る。

生き残った変異が出たら、原因を 3 つに分類して対応する。

1. **テストの穴** → その変異が壊す振る舞いを直接検証するテストを足す。
2. **出力を変えない最適化**（定数の言い換え、等価な条件式） → 呼び出し回数や引数そのものを検証するテストで縛る。
3. **到達不能なコード** → 到達できる形にコードを書き直してから、そこを通るテストを足して殺す。

**「除外する」は選択肢にない。** `stryker.config.json` の `mutate` から Phase 8 のファイルを外したり、`// Stryker disable` を書いたりしない。

- [ ] **Step 8: わざと壊して総点検が効いていることを確認する**

`packages/core/src/schema.ts` の `REVIEW_REPLY_BODY_MAX` を 1000 から 900 に変える。
Expected: FAIL。「レビュー返信の上限が一致する」が `expected 1000 to be 900` で落ちる。

次に `apps/api/src/routes/owner/index.ts` に、表に無いルートを 1 本足す。

```ts
ownerRoutes.get('/ping', (c) => c.json({ ok: true }));
```

Expected: FAIL。`permission-matrix.test.ts` の「ルート表と実装の突合」が 2 本とも落ち、差分に `'GET /owner/ping'` が現れる。

**2 つとも確認したら元に戻し、緑になることを確認する。**

- [ ] **Step 9: コミット**

```bash
git add apps/api/src/db/owner-constants-parity.test.ts apps/api/src/routes/permission-matrix.test.ts docs/design.md
git commit -m "test: Phase 8 の定数の突合テストを追加し、ルート表を実装と一致させる"
```

---

## Phase 8 完了チェックリスト

実装を終える前に、以下をすべて自分の手で確認する。「たぶん通っている」で閉じない。

### 動くこと

- [ ] `npm run test` が全ワークスペースで成功する
- [ ] `npm run typecheck` が成功する（`any` ゼロ、`@ts-expect-error` ゼロ）
- [ ] `npm run lint` が成功する
- [ ] `npm run test:mutation -w @meshimap/api` の変異スコアが 85 を上回る
- [ ] `apps/mobile` の Jest カバレッジが行・分岐・関数・文すべて 100%
- [ ] `npx wrangler d1 migrations apply meshimap --local` が成功する

### 権限の境界

- [ ] `/owner/**` の **31 本**（#14〜#44）すべてについて、未認証 401 / 一般ユーザー 403 / 管理者 403 / 自店オーナー 2xx を検証するテストがある。うち `:shopId` / `:reviewId` / `:campaignId` を取る **27 本**は他店オーナー 404 も検証する（残る 4 本 `/owner/shops` `/owner/application` `/owner/application/documents` `/owner/application/resubmit` には他店の概念が無い）
- [ ] 32 本目の `POST /shops/:shopId/views`（#45）は公開なので、匿名を含む全ロールで 204 を検証している。合わせて Task 8-14 Step 16 で `ENDPOINT_CASES` に追加した 32 行になる
- [ ] `ENDPOINT_CASES` の件数と実ルート件数が一致している（Task 8-23）。`EXPECTED_ROUTE_PATTERNS` が **51 本**（Phase 7 後の 19 + Phase 8 の 32）で昇順、`DELEGATED_ROUTE_PATTERNS` は**予約系 9 本のまま**、`DELEGATABLE_PATH_PATTERN` も**変更していない**
- [ ] 所有権の判定が `WHERE owner_id = ?` の形で SQL に入っていて、アプリ層で取得後に比較している箇所が無い
- [ ] 他店の ID を指定したとき、応答本文に他店の情報が 1 文字も含まれない

### 画面

- [ ] `(owner)/` の 16 画面（予約 2 画面は Phase 7）がすべて存在し、ルーティングが通っている
- [ ] 各画面に「読み込み中」「エラー（再試行つき）」「空」の 3 状態がある
- [ ] 新規 UI プリミティブを作っていない（`components/ui/` に Phase 8 で追加したファイルが無い）
- [ ] `default export` は expo-router の画面と `_layout` だけ

### データの整合

- [ ] `geohash` はサーバでのみ導出している（リクエスト本文に `geohash` を含める経路が無い）
- [ ] R2 の削除は D1 を先に消してから行っている（Task 8-8）
- [ ] 画像は magic number で種別を判定していて、`Content-Type` ヘッダを信用していない（Task 8-7）
- [ ] マイグレーションの CHECK 制約と `packages/core` の定数が一致している（Task 8-23）

### 文言

- [ ] エラー文言はすべて `src/lib/http-error.ts` の固定文言で、例外メッセージをそのまま返している箇所が無い
- [ ] 画面の文言がハードコードではなく定数になっている（`constants/owner.ts`）
- [ ] `accessibilityLabel` が星の数・未設定・件数などを「読める日本語」で持っている

---

## 次フェーズへの引き継ぎ

### Phase 9（管理者）が Phase 8 から受け取るもの

| もの                                               | 場所                                                                        | 使い方                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shop_applications` / `shop_application_documents` | Task 8-2 のマイグレーション                                                 | 管理者の審査画面が `status` を `pending` → `approved` / `rejected` / `returned` に変える。`reviewNote` は管理者が書く。**初回申請（`user` → `owner`）の入口は Phase 9 Task 9-25 〜 9-27 が作る**（判断 7 の訂正を参照）                                                                                                                       |
| `requireOwner` の作り                              | `apps/api/src/routes/owner/guard.ts`                                        | 管理者側は `requireAdmin` を同じ形で作る。ロールだけで弾くので 403、リソース単位の判定は不要                                                                                                                                                                                                                                                  |
| `EXPECTED_ROUTE_PATTERNS`（51 本）                 | `apps/api/src/routes/permission-matrix.test.ts`（Phase 4 Task 4-12 / 4-14） | `/admin/**` の 32 本を**昇順を保って**足して 83 本にする（Phase 9 Task 9-17）。`/admin` は既存のどのパスより小さいのでメソッド群ごとの先頭に入る。さらに Phase 9 Task 9-26 が初回店舗申請の 4 本（`GET /masters` / `POST /shop-applications` / `GET /shop-applications/me` / `POST /shop-applications/me/documents`）を足して **87 本**にする |
| `DELEGATED_ROUTE_PATTERNS`（予約系 9 本のまま）    | 同上（Phase 7 が導入）                                                      | **Phase 9 は委譲側に積む。** `/admin/**` 32 本を同じ 32 本ぶんここにも足して 41 本にし、`DELEGATABLE_PATH_PATTERN` に `admin` の 1 語を足す。主体ごとの総当たり 128 ケースは `apps/api/src/routes/admin/permission-matrix.test.ts` が持つので、**`ENDPOINT_CASES` には `/admin/**` の行を足さない**（Phase 8 の 32 本とは扱いが違う）         |
| `ENDPOINT_CASES`（Phase 8 の 32 行を含む）         | 同上                                                                        | Phase 8 の行はそのまま残す。オーナー系は委譲していないので、この表が主体ごとの期待値を持ち続ける。Phase 9 Task 9-26 は初回店舗申請の **4 行だけ**をここに足す（`/admin/**` ではないので委譲しない）                                                                                                                                           |
| `presentShop` などの整形関数                       | Task 8-6                                                                    | 管理者向けの応答でも同じ整形を使う。二重定義しない                                                                                                                                                                                                                                                                                            |
| R2 の読み書き                                      | Task 8-7 / 8-8                                                              | 管理者は書類（`shop_application_documents`）を読む必要がある。`MEDIA` バインディングと magic number 判定をそのまま使う                                                                                                                                                                                                                        |
| `moveItem` / `formatPriceYen` / `formatReviewDate` | `apps/mobile/src/lib/`                                                      | 汎用なのでそのまま使える                                                                                                                                                                                                                                                                                                                      |

### Phase 8 が Phase 7（予約）に依存しているもの

- `(owner)/(tabs)/reservations.tsx` と `(owner)/reservations/[reservationId].tsx` は **Phase 7 の担当**。Phase 8 はこの 2 画面を作らない。
- Phase 8 のダッシュボード（Task 8-16）と店舗ハブ（Task 8-18）から `router.push('/reservations')` で遷移するだけ。**遷移先の画面が未実装のうちは、テストで `mockPush` の引数を検証するにとどめる。**
- ダッシュボードの KPI に「本日の予約件数」を出す（Task 8-16）。値の取得は `GET /owner/shops/:shopId/stats`（Phase 8 の #15）で、Phase 7 の API には依存しない。

### 意図的に Phase 8 でやらなかったこと

| やらなかったこと         | 理由                                                                                                     | いつやるか   |
| ------------------------ | -------------------------------------------------------------------------------------------------------- | ------------ |
| 画像のリサイズ・圧縮     | Worker の CPU 時間で画像処理をすると 50ms 制限に当たる。Cloudflare Images を使うかは運用開始後に判断する | 運用後       |
| 写真のドラッグ並べ替え   | 新しい依存が要る上にテストが書けない。上下ボタンで同じことができる（Task 8-19）                          | 需要が出たら |
| クーポンのプッシュ通知   | 通知基盤そのものが未着手                                                                                 | 別フェーズ   |
| KPI の期間指定（月・年） | 直近 30 日で用は足りる。期間選択を足すと集計 SQL とグラフの両方が複雑になる                              | 需要が出たら |
| 複数店舗の一括操作       | 1 オーナー複数店舗は対応済み（店舗切り替え）だが、一括編集は要件に無い                                   | 要件が出たら |
| メニューの画像           | メニュー 1 品ごとに画像を持つと R2 のオブジェクト数が跳ねる。店舗写真で代替する                          | 需要が出たら |

---

## 未確認事項の一覧

この計画書を書いた時点で、**このリポジトリのファイルを読むだけでは確定できなかった**ものをここに集める。実装時に必ず実物で確認してから書くこと。

| #   | 内容                                                                                                          | 確認方法                                                                                                                                                                                                                                                                                                                        | 影響するタスク                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | Expo SDK 57 の `ImagePicker.launchImageLibraryAsync` の `mediaTypes` が配列形式か enum 形式か                 | `https://docs.expo.dev/versions/v57.0.0/sdk/imagepicker/` を読む                                                                                                                                                                                                                                                                | 8-19                                                                               |
| 2   | `react-native-maps` が jest-expo のプリセット下でそのまま render できるか（`__mocks__` が要るか）             | 実際にテストを 1 本走らせる                                                                                                                                                                                                                                                                                                     | 8-19                                                                               |
| 3   | CI のタイムゾーン設定。`date-fns` の `format` はローカル TZ を見るので、UTC で動く CI だと日付が 1 日ずれ得る | `jest.config.js` の `globalSetup` と CI の env を確認し、必要なら `process.env.TZ = 'Asia/Tokyo'` を置く                                                                                                                                                                                                                        | 8-21                                                                               |
| 4   | `hono@^4.13.7` の `app.routes` の要素が `{ method, path }` を持つこと                                         | **確認済み（2026-09-16 実測）**。`node_modules/hono/dist/types/types.d.ts:26-31` の `interface RouterRoute` は `basePath: string` / `path: string` / `method: string` / `handler: H` を持つ。`basePath` もあるので、サブアプリを `route()` でマウントした場合に `path` が完全パスか相対パスかは 8-23 の実装時に一度確かめること | 8-23（既存の突合テストを流用するだけなので、形が違っても本計画書の追加作業は無い） |
| 5   | `@cloudflare/workers-types@5.20260915.1` の `R2Bucket` に署名 URL 生成 API が無いこと                         | `index.d.ts:2486-2516` を読んで確認済み（**確認済み**。ここに残すのは根拠の所在を示すため）                                                                                                                                                                                                                                     | 8-2 / 8-6                                                                          |
| 6   | miniflare の R2 エミュレーションが `httpMetadata.contentType` を往復で保つか                                  | `apps/api` のテストで put → get して確認する                                                                                                                                                                                                                                                                                    | 8-2 / 8-6                                                                          |
| 7   | `expo-image` の `source` に `file://` を渡したときの iOS / Android の挙動差                                   | 実機またはシミュレータで確認する。テストでは検証できない                                                                                                                                                                                                                                                                        | 8-19                                                                               |
| 8   | Stryker の `mutate` 設定に `src/routes/owner/**` と `src/repositories/owner-*.ts` が含まれているか            | `apps/api/stryker.config.json` を開く                                                                                                                                                                                                                                                                                           | 8-23                                                                               |

**上の 8 件のうち、5 番だけが「確認済み」である。** 残りの 7 件は、この計画書を書いている時点で実物を見ていない。実装者はこれらについて、計画書の記述を鵜呑みにせず自分で確かめること。
