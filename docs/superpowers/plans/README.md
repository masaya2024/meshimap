# MeshiMap 実装計画インデックス

設計書: [`../specs/2026-09-15-meshimap-design.md`](../specs/2026-09-15-meshimap-design.md)
規約: [`../../CODING_GUIDELINES.md`](../../CODING_GUIDELINES.md)

61 画面（設計書 §5 の「見た目のある画面は 61」）+ Cloudflare バックエンドは 1 つの計画に収まらないため、**フェーズごとに独立した計画**に分ける。
各フェーズは単体で「動く・テストが通る」状態に到達する。

## 進め方の原則

- **TDD**: 失敗するテストを書く → 失敗を確認する → 通す最小実装 → リファクタ
- **ミューテーションテスト**: `packages/geo` / `packages/core` はスコア 85% を下回ったら失敗扱い
- **1 タスク = 1 コミット**: タスク末尾で必ずコミットする
- **回帰**: タスク完了の条件は「そのタスクのテスト」ではなく「`npm test` 全件が緑」

## 現在の状況（2026-09-15 時点）

| 項目             | 実測値                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------- |
| ブランチ         | `feat/phase-0-foundation`                                                                |
| 完了フェーズ     | Phase 0 / Phase 1 / Phase 2 / **Phase 3**                                                |
| 進行中           | Phase 4（計画書は作成済み。実装はこれから）                                              |
| テスト件数       | `packages/core` 326 ＋ `packages/geo` 205 ＋ `apps/api` 414 ＋ `apps/mobile` 128 = 1073  |
| D1 テーブル      | 25 本（Better Auth 4 + アプリ 21）を Drizzle スキーマとして定義済み                      |
| マイグレーション | `migrations/0000_init.sql` と `0001_shops_fts.sql`（FTS5 + 同期トリガー 3 本）が適用済み |

数字は Phase 3 完了時点（Task 3-14 の品質ゲートを通した直後）の実測。

Phase 3 で追加した検証のうち、他フェーズでも効き続けるものが 2 つある。

- **CHECK 制約の網羅メタテスト**（`apps/api/src/db/schema/check-constraints.test.ts`）:
  マイグレーション上の CHECK 制約 104 個が 1 つ残らずテストで名指しされていることを機械的に縛る。
  制約を足してテストを書き忘れると赤くなる（実測で確認済み）。
- **部分索引の DDL 検証**: 部分索引 3 本の `WHERE` 句を `sqlite_master` の DDL で直接見る。
  `EXPLAIN QUERY PLAN` の索引名だけでは `WHERE` が消えても検知できないため。

---

## フェーズ一覧

| Phase | 内容                                                         | タスク数     | 詳細計画                                          | 状態     |
| ----- | ------------------------------------------------------------ | ------------ | ------------------------------------------------- | -------- |
| 0     | モノレポ基盤 / デザインシステム / UI プリミティブ            | 14           | [phase-0](./2026-09-15-phase-0-foundation.md)     | 完了     |
| 1     | `packages/geo`（地理計算）を TDD で実装                      | 13           | [phase-1](./2026-09-15-phase-1-geo-package.md)    | 完了     |
| 2     | `packages/core`（ドメインロジック）を TDD で実装             | 13           | [phase-2](./2026-09-15-phase-2-core-package.md)   | 完了     |
| 3     | D1 スキーマ / マイグレーション / シード                      | 15           | [phase-3](./2026-09-15-phase-3-database.md)       | 完了     |
| 4     | API 基盤（Hono / 認証 / ロールガード / ブランド型 Actor）    | 15           | [phase-4](./2026-09-15-phase-4-api-foundation.md) | 計画済み |
| 5     | 認証 + ロールルーティング（モバイル）                        | 21           | [phase-5](./2026-09-15-phase-5-auth-routing.md)   | 計画済み |
| 6     | 利用者コア（地図 / 検索 / 店舗詳細 / レビュー / お気に入り） | 37           | [phase-6](./2026-09-15-phase-6-user-core.md)      | 計画済み |
| 7     | 予約（利用者 + 店舗側承認 + Durable Objects）                | 13（見込み） | 実行時に作成                                      | 未着手   |
| 8     | 店舗管理者（ダッシュボード / 店舗編集 / メニュー / 返信）    | 19（見込み） | 実行時に作成                                      | 未着手   |
| 9     | システム管理者（審査 / 通報 / ユーザー管理 / 監査ログ）      | 15（見込み） | 実行時に作成                                      | 未着手   |
| 10    | 仕上げ（通知 / ディープリンク / README / デモ）              | 10（見込み） | 実行時に作成                                      | 未着手   |

**タスク数の集計**

| 区分                                         |              タスク数 |
| -------------------------------------------- | --------------------: |
| 計画書が確定しているフェーズ（0〜3 / 5 / 6） |               **113** |
| 計画書が未作成のフェーズ（7〜10・見込み）    |                **57** |
| Phase 4                                      |                執筆中 |
| 合計                                         | **170 ＋ Phase 4 分** |

Phase 4 の計画書は別作業で執筆中でタスク数が変動するため、合計に含めていない。

**見込み値は当てにならない。** Phase 3 / 5 / 6 は、計画書を書く段階でそれぞれ 12 → 15、9 → 21、
22 → 37 にタスクが増えた（実際に必要な下ごしらえ・テスト基盤・分割が、着手前の見積もりに入っていなかったため）。
Phase 7〜10 の見込み値も同じ理由で増える前提で読むこと。

詳細計画は着手直前に作る。先に全部書くと、前フェーズの実装で判明した事実が反映されず陳腐化するため。
Phase 3 / 5 / 6 は Phase 2 完了時点の実測値をもとに先行して作成済み。Phase 4 は現在執筆中。

---

## Phase 0: モノレポ基盤 / デザインシステム（14 タスク・完了）

パスは `apps/mobile/` からの相対。

| #    | タスク                      | 成果物                                                                                              | 依存      |
| ---- | --------------------------- | --------------------------------------------------------------------------------------------------- | --------- |
| 0-1  | NativeWind 設定             | `babel.config.js`, `metro.config.js`, `tailwind.config.js`, `src/global.css`, `nativewind-env.d.ts` | —         |
| 0-2  | テーマ定数                  | `src/constants/theme.ts`（色 / 余白 / 角丸 / 影 / z-index）                                         | 0-1       |
| 0-3  | Tailwind へテーマを反映     | `tailwind.config.js` の `theme.extend`                                                              | 0-2       |
| 0-4  | Google Fonts 読み込み       | `src/constants/fonts.ts`, `src/hooks/use-app-fonts.ts`, `src/app/_layout.tsx`                       | 0-3       |
| 0-5  | ロガー                      | `src/lib/logger.ts`（`console.log` 禁止の受け皿）                                                   | —         |
| 0-6  | Jest 環境構築               | `jest.config.js`, `jest-setup.ts`, サンプルテストが通る                                             | —         |
| 0-7  | `Button`                    | `src/components/ui/button.tsx` + テスト（variant / size / disabled / onPress）                      | 0-3, 0-6  |
| 0-8  | `Card`                      | `src/components/ui/card.tsx` + テスト                                                               | 0-7       |
| 0-9  | `Badge`                     | `src/components/ui/badge.tsx` + テスト（tone: neutral/success/warning/danger）                      | 0-7       |
| 0-10 | `Input`                     | `src/components/ui/input.tsx` + テスト（label / error / 必須表示）                                  | 0-7       |
| 0-11 | `Skeleton`                  | `src/components/ui/skeleton.tsx` + テスト（アニメーション有無）                                     | 0-7       |
| 0-12 | `EmptyState` / `ErrorState` | `src/components/ui/empty-state.tsx`, `error-state.tsx` + テスト                                     | 0-9       |
| 0-13 | `Icon` ラッパ               | `src/components/ui/icon.tsx`（lucide のサイズ/色をテーマに揃える） + テスト                         | 0-2       |
| 0-14 | プリミティブのカタログ画面  | `src/app/_dev/catalog.tsx`（開発時のみ表示）                                                        | 0-7〜0-13 |

完了時点の実測: `npm test -w @meshimap/mobile` 15 スイート / 105 件 PASS、typecheck エラーなし、
`src/` 配下に `console.log` 0 件（計画書「Phase 0 完了条件」より）。

## Phase 1: `packages/geo`（13 タスク・完了）

すべて純粋関数。カバレッジ 100% + ミューテーションスコア 85% 以上が完了条件。
詳細計画中の期待値（geohash・距離・セル幅）はすべて実測して確定済み。

| #    | タスク                            | 主な関数                                          | 重点的に書くテスト                                              |
| ---- | --------------------------------- | ------------------------------------------------- | --------------------------------------------------------------- |
| 1-0  | 定数とテスト基盤の疎通            | `EARTH_RADIUS_M`, `GEOHASH_BASE32`                | 基数表が 32 文字で重複なし                                      |
| 1-1  | 座標のブランド型                  | `toLatitude`, `toLongitude`, `coordinate`         | 範囲外（±90 超 / ±180 超）を拒否                                |
| 1-2  | Haversine 距離                    | `distanceMeters(a, b)`                            | 同一点 = 0 / 東京-大阪の既知距離 / 日付変更線跨ぎ / 極付近      |
| 1-3  | 距離の表示整形                    | `formatDistance(m)`                               | 999m→"999m" / 1000m→"1.0km" / 丸めの境界                        |
| 1-4  | geohash エンコード                | `encodeGeohash(coord, precision)`                 | 既知の座標→既知のハッシュ / precision 1〜12                     |
| 1-5  | geohash デコード                  | `toGeohash`, `decodeGeohash(hash)`                | エンコードとの往復 / 不正文字を拒否                             |
| 1-6  | geohash 近傍セル                  | `wrapLongitude`, `neighborCells(hash)`            | 8 近傍が返る / 経度 180 度境界 / 極セル                         |
| 1-7  | 半径→precision                    | `precisionForRadius(radiusM)`                     | 各境界値でセル幅が半径を上回る最小 precision                    |
| 1-8  | 半径→検索セル群                   | `cellsForRadius(center, radiusM)`                 | 半径が大きいほどセルが減る（precision 低下）                    |
| 1-9  | 境界ボックス生成                  | `boundingBox(center, radiusM)`                    | 半径 0 / 極付近で緯度がクランプされる                           |
| 1-10 | 境界ボックス内判定                | `isWithinBounds(coord, bbox)`                     | 境界線上 = 内側 / 日付変更線を跨ぐ bbox                         |
| 1-11 | グリッドクラスタリング            | `precisionForZoom`, `clusterByGrid(points, zoom)` | 同一セルは 1 クラスタ / zoom 増でクラスタ分裂 / 空配列          |
| 1-12 | 公開 API とミューテーションテスト | `index.ts` バレル                                 | 公開シンボル一覧の固定 / 3 段階検索の通し実行 / スコア 85% 以上 |

完了時点の実測: 9 ファイル / 203 件 PASS、カバレッジ Statements・Branches・Functions・Lines すべて 100%、
`dependencies` は空のまま（計画書「Phase 1 完了チェックリスト」より）。

## Phase 2: `packages/core`（13 タスク・完了）

計画作成時に、旧ロードマップの 11 タスクから 13 タスクへ組み替えた（`2-0` 基盤整備と `2-12` 品質ゲートを新設、
`MinuteOfDay` と JST クロックを分離、営業時間の型と表示／営業中判定と営業ステータスをそれぞれ統合）。
理由は計画書 §7「タスク一覧と README からの差分」にある。

| #    | タスク                      | 主な関数・型                                                                            | 重点的に書くテスト                                    |
| ---- | --------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 2-0  | 基盤整備                    | `constants.ts`, `@meshimap/geo` 依存, Stryker 設定                                      | 定数が重複せず矛盾しない                              |
| 2-1  | ロール定義                  | `Role`, `isRole`, `toRole`, `ROLES`, `canManageShop`, `canModerate`                     | 未知の値を拒否                                        |
| 2-2  | ID ブランド型               | `ShopId`, `UserId`, `ReviewId`, `ReservationId` と `toXxxId`                            | 取り違えがコンパイルエラーになる（型テスト）          |
| 2-3  | 分単位時刻 `MinuteOfDay`    | `minuteOfDay`, `toMinuteOfDay`, `formatMinuteOfDay`                                     | 分単位変換 / 日跨ぎ表現（0〜2879）                    |
| 2-4  | JST クロック                | `toJstClock`, `toJstDate`, `dayOfWeekOf`, `addJstDays`                                  | 実行環境の TZ に依存しない（`getUTC*` のみ使う）      |
| 2-5  | 営業時間の型と表示          | `BusinessHours`, `ShopClosure`, `businessHoursOn`, `formatBusinessHours`, `isOvernight` | 日跨ぎを "18:00 - 翌 1:30" と表示                     |
| 2-6  | 営業中判定と営業ステータス  | `isCurrentlyOpen`, `minutesUntilClose`, `getOpenStatus`                                 | 開店/閉店ちょうど / 日跨ぎ 01:00 / 閉店 30 分前       |
| 2-7  | 予約枠生成                  | `generateSlots`, `assertSeatSettings`                                                   | 枠が営業時間内に収まる / 端数の切り捨て               |
| 2-8  | 予約可否                    | `canReserve`                                                                            | 満席 / 定員超過 / 受付停止中                          |
| 2-9  | 評価集計                    | `summarizeRatings`, `toRating`                                                          | 平均の丸め（4.45 の扱い）/ 分布 / 0 件                |
| 2-10 | 予算帯の表示                | `formatBudgetRange`, `formatYen`, `BUDGET_UNSET_LABEL`                                  | 片方 null / 同額 / 未設定                             |
| 2-11 | Zod スキーマ                | `shopCreateSchema` ほか                                                                 | 必須・文字数・範囲の境界                              |
| 2-12 | 公開 API バレルと品質ゲート | `index.ts`                                                                              | 公開シンボル一覧の固定 / スコア 85% 以上（実測 100%） |

`getOpenStatus` の戻り値は `open` / `closing-soon` / `closed` / `regular-holiday` の 4 値。
完了時点の実測: 323 件 PASS、カバレッジ 100%、ミューテーションスコア 100.00%。

## Phase 3: D1 スキーマ / マイグレーション / シード（15 タスク・実装中）

到達点は「データが引ける」。全テーブルが Drizzle スキーマとして定義され、マイグレーションがローカル D1 に
適用でき、制約違反が実際に弾かれることをテストで示せる状態。

| #    | タスク                                                     | 主な成果物                                            | 状態   |
| ---- | ---------------------------------------------------------- | ----------------------------------------------------- | ------ |
| 3-0  | 基盤整備（依存追加 / 設定ファイル / ローカル D1 の作成）   | `vitest.config.ts`, `drizzle.config.ts`, `.gitignore` | 完了   |
| 3-1  | `db/constants.ts` — enum 相当の値と数値範囲                | `constants.ts`                                        | 完了   |
| 3-2  | `db/schema/auth.ts` — Better Auth の 4 テーブル            | `auth.ts`                                             | 完了   |
| 3-3  | `db/schema/master.ts` — profiles / genres / areas          | `master.ts`                                           | 完了   |
| 3-4  | `db/schema/shop.ts` — shops と地理空間索引                 | `shop.ts`                                             | 完了   |
| 3-5  | `db/schema/shop-detail.ts` — 営業時間 / 臨時休業 / 写真    | `shop-detail.ts`                                      | 完了   |
| 3-6  | `db/schema/menu.ts` — メニュー / 席設定                    | `menu.ts`                                             | 完了   |
| 3-7  | `db/schema/review.ts` — レビュー / 写真 / 返信             | `review.ts`                                           | 完了   |
| 3-8  | `db/schema/reservation.ts` + `collection.ts`               | `reservation.ts`, `collection.ts`                     | 完了   |
| 3-9  | `db/schema/admin.ts` — 通報 / 申請 / 通知 / 監査ログ       | `admin.ts`                                            | 完了   |
| 3-10 | `schema/index.ts` + `client.ts` + 初回マイグレーション生成 | `migrations/0000_init.sql`                            | 完了   |
| 3-11 | FTS5 仮想テーブルと同期トリガ（手書きマイグレーション）    | `migrations/0001_shops_fts.sql`                       | 実行中 |
| 3-12 | シード生成（東京 12 エリア・店舗 60 件）                   | `scripts/generate-seed.ts`, `seeds/seed.sql`          | 未着手 |
| 3-13 | 3 段構え地理空間検索の実装と検証                           | `queries/nearby-shops.ts`                             | 未着手 |
| 3-14 | 品質ゲート（型検査 / 全テスト / マイグレーション再現性）   | —                                                     | 未着手 |

3 段構えの検索は geohash 前方一致 → 境界ボックス → Haversine の順で絞る（設計書 §3.1）。
Task 3-11 が完了するまで `npm test -w @meshimap/api` は緑にならない。

## Phase 4: API 基盤（計画を執筆中）

計画書 [`2026-09-15-phase-4-api-foundation.md`](./2026-09-15-phase-4-api-foundation.md) は別作業で執筆中。
タスク数・タスクの区切りとも確定していないため、ここには一覧を載せない。最新はファイル本体を見ること。

このフェーズの到達点は設計書 §12 のとおり「権限の抜けがないことを証明できる」。
中核は Hono の骨格、Better Auth の設定、ブランド型 `Actor`（`UserActor` / `OwnerActor` / `AdminActor`）、
ロールガード、リポジトリ層、そしてロール × エンドポイントの網羅権限テストと `AppType` の export。

## Phase 5: 認証 + ロールルーティング（モバイル）（21 タスク・計画済み）

到達点は「3 ロールでログイン分岐する」。アクセス制御は expo-router 57 の `<Stack.Protected guard={...}>`、
着地先の決定はアンカールート `app/index.tsx` の `<Redirect>` が担うハイブリッド方式。

| #    | タスク                                                           |
| ---- | ---------------------------------------------------------------- |
| 5-1  | ロール・ルート・HTTP の定数と認証状態の型を定義する              |
| 5-2  | Better Auth クライアントを SecureStore 永続化つきで作る          |
| 5-3  | Hono RPC の API クライアントを作る（Phase 4 と切り離して進める） |
| 5-4  | 認証エラーの日本語化と `features/auth` の API ラッパーを作る     |
| 5-5  | 認証状態コンテキストを作る（復元中を表現できる 4 状態）          |
| 5-6  | 画面の枠（`PlaceholderScreen` / `AuthLoadingScreen`）を作る      |
| 5-7  | ルートグループの骨組みを作る（全 `_layout` + プレースホルダ）    |
| 5-8  | ルート `_layout.tsx` に Providers とアクセス制御を組み込む       |
| 5-9  | `index.tsx` をロールディスパッチャにし、`+not-found.tsx` を作る  |
| 5-10 | `Input` にキーボード挙動・`onBlur`・無効化を追加する             |
| 5-11 | `PasswordInput` を作る                                           |
| 5-12 | 認証フォームの共通部品を作る（文言変換 / エラーバナー / 外枠）   |
| 5-13 | 認証ミューテーションの共通フックとサインイン画面を実装する       |
| 5-14 | 新規登録画面を実装する                                           |
| 5-15 | メール確認待機画面を実装する                                     |
| 5-16 | パスワード再設定の申請画面を実装する                             |
| 5-17 | welcome（オンボーディング）画面を実装する                        |
| 5-18 | サインアウトを実装する（3 ロール分の設定画面まで）               |
| 5-19 | 店舗申請（user → owner 昇格）の導線を実装する                    |
| 5-20 | ルーティングの統合テストを書く                                   |
| 5-21 | Phase 5 の総点検と設計書の追従                                   |

設計書 §5.1 からの意図的な逸脱が 1 箇所ある。利用者ホームを `(user)/(tabs)/index.tsx` ではなく
`(user)/(tabs)/home.tsx` にする（グループ名は URL に出ないため `app/index.tsx` と URL が衝突するのを避ける）。
Task 5-21 で設計書側にも反映する。

## Phase 6: 利用者コア（37 タスク・計画済み）

到達点は「デモ可能な状態」。地図から店を探し、絞り込み、詳細を見て、レビューを書き、
お気に入りに入れるまでの動線を通す。

| #    | タスク                                                         |
| ---- | -------------------------------------------------------------- |
| 6-1  | 地図とボトムシートが動く土台を作る                             |
| 6-2  | テスト基盤（ネイティブモジュールのモックと共通ユーティリティ） |
| 6-3  | 地図の定数を定義する                                           |
| 6-4  | Region と `@meshimap/geo` の橋渡しを作る                       |
| 6-5  | 地図ビューポートのストアを作る                                 |
| 6-6  | 現在地取得フック（権限拒否時のフォールバック付き）を作る       |
| 6-7  | 「このエリアを再検索」の表示判定フックを作る                   |
| 6-8  | 検索フィルタの型と URL クエリ変換を作る                        |
| 6-9  | 店舗 API 層（zod スキーマ + fetch）を作る                      |
| 6-10 | 店舗のクラスタリングと周辺検索フックを作る                     |
| 6-11 | 店舗マーカーを作る                                             |
| 6-12 | クラスタマーカーを作る                                         |
| 6-13 | 「このエリアを再検索」ボタンを作る                             |
| 6-14 | 営業状態バッジと営業状態の算出を作る                           |
| 6-15 | 店舗カードを作る                                               |
| 6-16 | 地図のボトムシートを作る                                       |
| 6-17 | 地図画面を組み上げる                                           |
| 6-18 | 検索フィルタのストアと URL 同期を作る                          |
| 6-19 | フィルタチップとフィルタシートを作る                           |
| 6-20 | キーワード検索フックと検索画面を作る                           |
| 6-21 | 店舗詳細の取得フックを作る                                     |
| 6-22 | スクロール連動ヘッダーを作る                                   |
| 6-23 | 評価分布グラフを作る                                           |
| 6-24 | 週間営業時間の表を作る                                         |
| 6-25 | 店舗基本情報と写真ギャラリーの部品を作る                       |
| 6-26 | レビューの型と星表示を作る                                     |
| 6-27 | レビューカードを作る                                           |
| 6-28 | レビューの API 層と取得・投稿フックを作る                      |
| 6-29 | レビュー投稿フォームの入力部品を作る                           |
| 6-30 | 現在時刻フック・予算入力・投稿フォームのスキーマを作る         |
| 6-31 | レビュー投稿画面を作る                                         |
| 6-32 | お気に入りの API 層と楽観更新フックを作る                      |
| 6-33 | お気に入りボタンと保存済み画面を作る                           |
| 6-34 | 区画枠・メニュー一覧・全画面写真ビューアを作る                 |
| 6-35 | レビュー一覧セクションを作る                                   |
| 6-36 | 店舗詳細画面を組み立てる                                       |
| 6-37 | 画面テストをルート配下から追い出し、フェーズ全体を検証する     |

レビュー編集画面（`(user)/review/[reviewId]/edit.tsx`）は計画書の依頼範囲外のため Phase 6 では作らない。
詳細画面には入口のリンクだけを置く。

---

以降は計画書が未作成のフェーズ。タスクの粒度・数は着手時の計画作成で確定する（下表は見込み）。

## Phase 7: 予約（13 タスク・見込み）

| #    | タスク                                                        |
| ---- | ------------------------------------------------------------- |
| 7-1  | `ReservationLock` Durable Object（枠の直列化）                |
| 7-2  | 予約リポジトリ（作成 / 取得 / キャンセル）+ 権限テスト        |
| 7-3  | 予約枠 API（`generateSlots` を利用）                          |
| 7-4  | 二重予約の並行テスト（同時リクエストで 1 件だけ成功すること） |
| 7-5  | 予約ルート + RPC 型                                           |
| 7-6  | `components/reservation/slot-picker.tsx`                      |
| 7-7  | `(user)/shop/[shopId]/reserve.tsx`                            |
| 7-8  | `(user)/reservations/index.tsx`                               |
| 7-9  | `(user)/reservations/[reservationId].tsx`（キャンセル）       |
| 7-10 | 店舗側: 予約一覧 API（オーナー権限）                          |
| 7-11 | `(owner)/(tabs)/reservations.tsx`                             |
| 7-12 | `(owner)/reservations/[reservationId].tsx`（承認 / 拒否）     |
| 7-13 | 予約ステータス変更の通知レコード作成                          |

## Phase 8: 店舗管理者（19 タスク・見込み）

| #    | タスク                                                        |
| ---- | ------------------------------------------------------------- |
| 8-1  | 店舗申請 API + `shop_applications` リポジトリ                 |
| 8-2  | `(user)/settings/shop-application.tsx`                        |
| 8-3  | `(owner)/onboarding/apply.tsx`                                |
| 8-4  | `(owner)/onboarding/status.tsx`                               |
| 8-5  | KPI 集計 API（期間別 / 前期間比）+ KV キャッシュ              |
| 8-6  | `components/chart/line-chart.tsx`（react-native-svg）+ テスト |
| 8-7  | `components/chart/kpi-card.tsx` + テスト                      |
| 8-8  | `(owner)/(tabs)/dashboard.tsx`                                |
| 8-9  | `(owner)/(tabs)/shop.tsx` ハブ                                |
| 8-10 | `(owner)/shop/basic.tsx`                                      |
| 8-11 | `(owner)/shop/hours.tsx`（日跨ぎ入力 UI）                     |
| 8-12 | `(owner)/shop/location.tsx`（ピンドラッグ → geohash 再計算）  |
| 8-13 | `(owner)/shop/photos.tsx`（並べ替え / カバー指定）            |
| 8-14 | `(owner)/shop/seats.tsx`                                      |
| 8-15 | メニュー API + 権限テスト                                     |
| 8-16 | `(owner)/shop/menu/index.tsx`                                 |
| 8-17 | `(owner)/shop/menu/[menuItemId].tsx`                          |
| 8-18 | レビュー返信 API + `(owner)/reviews/[reviewId]/reply.tsx`     |
| 8-19 | `(owner)/(tabs)/reviews.tsx` + `campaigns/` 2 画面            |

Phase 5 の Task 5-19 が店舗申請の導線（`(user)/settings/shop-application.tsx` と
`(owner)/onboarding/status.tsx`）を先に作るため、8-2 / 8-4 の範囲は着手時に見直すこと。

## Phase 9: システム管理者（15 タスク・見込み）

| #    | タスク                                                   |
| ---- | -------------------------------------------------------- |
| 9-1  | 審査 API（承認 / 差し戻し）+ ロール昇格 + 監査ログ       |
| 9-2  | `(admin)/(tabs)/approvals.tsx`                           |
| 9-3  | `(admin)/approvals/[applicationId].tsx`                  |
| 9-4  | 通報 API（作成 / 解決 / 却下）                           |
| 9-5  | `(user)/report/[targetType]/[targetId].tsx`              |
| 9-6  | `(admin)/(tabs)/reports.tsx`                             |
| 9-7  | `(admin)/reports/[reportId].tsx`（コンテンツ非表示化）   |
| 9-8  | ユーザー管理 API（検索 / 停止 / ロール変更）+ 権限テスト |
| 9-9  | `(admin)/(tabs)/users.tsx`                               |
| 9-10 | `(admin)/users/[userId].tsx`                             |
| 9-11 | `(admin)/shops/[shopId].tsx`（強制非公開）               |
| 9-12 | マスタ API + `(admin)/masters/genres.tsx`                |
| 9-13 | `(admin)/masters/areas.tsx`                              |
| 9-14 | `(admin)/audit-log.tsx`                                  |
| 9-15 | `(admin)/(tabs)/overview.tsx` + `announcements.tsx`      |

## Phase 10: 仕上げ（10 タスク・見込み）

| #     | タスク                                                           |
| ----- | ---------------------------------------------------------------- |
| 10-1  | プッシュ通知（expo-notifications + トークン登録 API）            |
| 10-2  | 通知送信（予約承認 / レビュー返信）+ `(user)/notifications.tsx`  |
| 10-3  | ディープリンク（店舗 / リスト共有）                              |
| 10-4  | 画面遷移アニメーションと触覚フィードバック                       |
| 10-5  | ダークモード全画面確認と修正                                     |
| 10-6  | エラーバウンダリとオフライン表示                                 |
| 10-7  | `apps/api` を Cloudflare へデプロイ                              |
| 10-8  | EAS ビルド設定（iOS / Android の開発ビルド）                     |
| 10-9  | README（スクリーンショット / アーキテクチャ図 / 設計判断の説明） |
| 10-10 | デモ動画と最終の全テスト実行                                     |
