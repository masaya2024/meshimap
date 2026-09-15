# MeshiMap 実装計画インデックス

設計書: [`../specs/2026-09-15-meshimap-design.md`](../specs/2026-09-15-meshimap-design.md)
規約: [`../../CODING_GUIDELINES.md`](../../CODING_GUIDELINES.md)

61 画面 + Cloudflare バックエンドは 1 つの計画に収まらないため、**フェーズごとに独立した計画**に分ける。
各フェーズは単体で「動く・テストが通る」状態に到達する。

## 進め方の原則

- **TDD**: 失敗するテストを書く → 失敗を確認する → 通す最小実装 → リファクタ
- **ミューテーションテスト**: `packages/geo` / `packages/core` はスコア 85% を下回ったら失敗扱い
- **1 タスク = 1 コミット**: タスク末尾で必ずコミットする
- **回帰**: タスク完了の条件は「そのタスクのテスト」ではなく「`npm test` 全件が緑」

## フェーズ一覧

| Phase | 内容 | タスク数 | 詳細計画 | 状態 |
|---|---|---:|---|---|
| 0 | モノレポ基盤 / デザインシステム / UI プリミティブ | 14 | [phase-0](./2026-09-15-phase-0-foundation.md) | 未着手 |
| 1 | `packages/geo`（地理計算）を TDD で実装 | 13 | [phase-1](./2026-09-15-phase-1-geo-package.md) | 未着手 |
| 2 | `packages/core`（ドメインロジック）を TDD で実装 | 11 | 実行時に作成 | 未着手 |
| 3 | D1 スキーマ / マイグレーション / シード | 12 | 実行時に作成 | 未着手 |
| 4 | API 基盤（Hono / 認証 / 権限の型設計 / 店舗検索） | 12 | 実行時に作成 | 未着手 |
| 5 | モバイル認証 + ロールルーティング | 9 | 実行時に作成 | 未着手 |
| 6 | 利用者コア（地図 / 検索 / 店舗詳細 / レビュー / 保存） | 22 | 実行時に作成 | 未着手 |
| 7 | 予約（利用者 + 店舗側承認 + Durable Objects） | 13 | 実行時に作成 | 未着手 |
| 8 | 店舗管理者（ダッシュボード / 店舗編集 / メニュー / 返信） | 19 | 実行時に作成 | 未着手 |
| 9 | システム管理者（審査 / 通報 / ユーザー管理 / 監査ログ） | 15 | 実行時に作成 | 未着手 |
| 10 | 仕上げ（通知 / ディープリンク / README / デモ） | 10 | 実行時に作成 | 未着手 |
| | **合計** | **150** | | |

詳細計画は着手直前に作る。先に全部書くと、前フェーズの実装で判明した事実が反映されず陳腐化するため。

---

## Phase 0: モノレポ基盤 / デザインシステム（14 タスク）

| # | タスク | 成果物 | 依存 |
|---|---|---|---|
| 0-1 | NativeWind 設定 | `babel.config.js`, `metro.config.js`, `tailwind.config.js`, `global.css`, `nativewind-env.d.ts` | — |
| 0-2 | テーマ定数 | `constants/theme.ts`（色 / 余白 / 角丸 / 影 / z-index） | 0-1 |
| 0-3 | Tailwind へテーマを反映 | `tailwind.config.js` の `theme.extend` | 0-2 |
| 0-4 | Google Fonts 読み込み | `constants/fonts.ts`, `app/_layout.tsx` のフォント読込 | 0-3 |
| 0-5 | ロガー | `lib/logger.ts`（`console.log` 禁止の受け皿） | — |
| 0-6 | Jest 環境構築 | `jest.config.js`, `jest-setup.ts`, サンプルテストが通る | — |
| 0-7 | `Button` | `components/ui/button.tsx` + テスト（variant / size / disabled / onPress） | 0-3, 0-6 |
| 0-8 | `Card` | `components/ui/card.tsx` + テスト | 0-7 |
| 0-9 | `Badge` | `components/ui/badge.tsx` + テスト（tone: neutral/success/warning/danger） | 0-7 |
| 0-10 | `Input` | `components/ui/input.tsx` + テスト（label / error / 必須表示） | 0-7 |
| 0-11 | `Skeleton` | `components/ui/skeleton.tsx` + テスト（アニメーション有無） | 0-7 |
| 0-12 | `EmptyState` / `ErrorState` | `components/ui/empty-state.tsx`, `error-state.tsx` + テスト | 0-9 |
| 0-13 | `Icon` ラッパ | `components/ui/icon.tsx`（lucide のサイズ/色をテーマに揃える） + テスト | 0-2 |
| 0-14 | プリミティブのカタログ画面 | `app/_dev/catalog.tsx`（開発時のみ表示） | 0-7〜0-13 |

## Phase 1: `packages/geo`（13 タスク）

すべて純粋関数。カバレッジ 100% + ミューテーションスコア 85% 以上が完了条件。
詳細計画中の期待値（geohash・距離・セル幅）はすべて実測して確定済み。

| # | タスク | 主な関数 | 重点的に書くテスト |
|---|---|---|---|
| 1-0 | 定数とテスト基盤の疎通 | `EARTH_RADIUS_M`, `GEOHASH_BASE32` | 基数表が 32 文字で重複なし |
| 1-1 | 座標のブランド型 | `toLatitude`, `toLongitude`, `coordinate` | 範囲外（±90 超 / ±180 超）を拒否 |
| 1-2 | Haversine 距離 | `distanceMeters(a, b)` | 同一点 = 0 / 東京-大阪の既知距離 / 日付変更線跨ぎ / 極付近 |
| 1-3 | 距離の表示整形 | `formatDistance(m)` | 999m→"999m" / 1000m→"1.0km" / 丸めの境界 |
| 1-4 | geohash エンコード | `encodeGeohash(coord, precision)` | 既知の座標→既知のハッシュ / precision 1〜12 |
| 1-5 | geohash デコード | `toGeohash`, `decodeGeohash(hash)` | エンコードとの往復 / 不正文字を拒否 |
| 1-6 | geohash 近傍セル | `wrapLongitude`, `neighborCells(hash)` | 8 近傍が返る / 経度 180 度境界 / 極セル |
| 1-7 | 半径→precision | `precisionForRadius(radiusM)` | 各境界値でセル幅が半径を上回る最小 precision |
| 1-8 | 半径→検索セル群 | `cellsForRadius(center, radiusM)` | 半径が大きいほどセルが減る（precision 低下） |
| 1-9 | 境界ボックス生成 | `boundingBox(center, radiusM)` | 半径 0 / 極付近で緯度がクランプされる |
| 1-10 | 境界ボックス内判定 | `isWithinBounds(coord, bbox)` | 境界線上 = 内側 / 日付変更線を跨ぐ bbox |
| 1-11 | グリッドクラスタリング | `precisionForZoom`, `clusterByGrid(points, zoom)` | 同一セルは 1 クラスタ / zoom 増でクラスタ分裂 / 空配列 |
| 1-12 | 公開 API とミューテーションテスト | `index.ts` バレル | 公開シンボル一覧の固定 / 3 段階検索の通し実行 / スコア 85% 以上 |

## Phase 2: `packages/core`（11 タスク）

| # | タスク | 主な関数・型 | 重点的に書くテスト |
|---|---|---|---|
| 2-1 | ロール定義 | `Role`, `isRole`, `ROLE_*` | 未知の値を拒否 |
| 2-2 | ID ブランド型 | `ShopId`, `UserId`, `ReviewId`, `ReservationId` | 取り違えがコンパイルエラーになる（型テスト） |
| 2-3 | 営業時間の型 | `BusinessHours`, `minuteOfDay` | 分単位変換 / 日跨ぎ表現（close > 1440） |
| 2-4 | 営業中判定 | `isCurrentlyOpen(hours, closures, now)` | 開店ちょうど / 閉店ちょうど / 日跨ぎ 01:00 / 臨時休業 |
| 2-5 | 営業ステータス | `getOpenStatus(...)` → `open`/`closing-soon`/`closed`/`regular-holiday` | 閉店 30 分前が `closing-soon` |
| 2-6 | 営業時間の表示 | `formatBusinessHours(hours)` | 日跨ぎを "18:00 - 翌 1:30" と表示 |
| 2-7 | 予約枠生成 | `generateSlots(hours, seatSettings, date)` | 枠が営業時間内に収まる / 端数の切り捨て |
| 2-8 | 予約可否 | `canReserve(slots, existing, partySize)` | 満席 / 定員超過 / 受付停止中 |
| 2-9 | 評価集計 | `summarizeRatings(reviews)` | 平均の丸め（4.45 の扱い）/ 分布 / 0 件 |
| 2-10 | 予算帯の表示 | `formatBudgetRange(min, max)` | 片方 null / 同額 / 未設定 |
| 2-11 | Zod スキーマ | `shopCreateSchema` ほか | 必須・文字数・範囲の境界 |

## Phase 3: D1 スキーマ / シード（12 タスク）

| # | タスク | 成果物 |
|---|---|---|
| 3-1 | Cloudflare リソース作成 | `wrangler d1 create` / `r2 bucket create` / `kv namespace create` → `wrangler.jsonc` の id 差し替え |
| 3-2 | 認証テーブル | `db/schema/auth.ts`（Better Auth 準拠: user / session / account / verification） |
| 3-3 | プロフィールとマスタ | `db/schema/profile.ts`, `master.ts`（profiles / genres / areas） |
| 3-4 | 店舗本体 | `db/schema/shop.ts`（shops + `geohash` / `lat` / `lng` インデックス） |
| 3-5 | 営業時間・写真 | `db/schema/shop-detail.ts`（shop_hours / shop_closures / shop_photos） |
| 3-6 | メニュー・席 | `db/schema/menu.ts`（menu_categories / menu_items / seat_settings） |
| 3-7 | レビュー | `db/schema/review.ts`（reviews / review_photos / review_replies） |
| 3-8 | 予約 | `db/schema/reservation.ts` |
| 3-9 | 保存・リスト | `db/schema/save.ts`（favorites / lists / list_items） |
| 3-10 | 運営系 | `db/schema/ops.ts`（reports / shop_applications / notifications / audit_logs） |
| 3-11 | FTS5 + マイグレーション適用 | `migrations/*.sql` 生成、`shops_fts` を手書き SQL で追加、ローカル適用成功 |
| 3-12 | シードデータ | `seeds/generate.ts`（東京 23 区に店舗 60 件、geohash を `@meshimap/geo` で算出）+ 3 ロールのテストアカウント |

## Phase 4: API 基盤（12 タスク）

| # | タスク | 成果物 | 重点 |
|---|---|---|---|
| 4-1 | Hono 骨格 | `src/index.ts`, `middleware/error-handler.ts` | エラーレスポンスの形を固定 |
| 4-2 | D1 クライアント | `db/client.ts`（リクエストごとに binding から生成） | binding は fetch 内でしか取れない |
| 4-3 | Better Auth 設定 | `lib/auth.ts`（Drizzle アダプタ + expo プラグイン + trustedOrigins） | — |
| 4-4 | Actor ブランド型 | `lib/actor.ts`（`UserActor`/`OwnerActor`/`AdminActor`、生成関数は非公開） | 外部から生成できないこと |
| 4-5 | 認証ミドルウェア | `middleware/auth.ts` | 無効セッションで 401 |
| 4-6 | ロールガード | `middleware/role-guard.ts`（`requireUser`/`requireOwner`/`requireAdmin`） | ロール不一致で 403 |
| 4-7 | テストハーネス | `test/harness.ts`（メモリ D1 + 3 ロールのテストユーザー） | 以降の全権限テストの土台 |
| 4-8 | 店舗検索リポジトリ | `repositories/shop-search.ts`（geohash → bbox → Haversine の 3 段） | 半径外が混ざらない / 距離順 |
| 4-9 | 店舗取得リポジトリ | `repositories/shop-read.ts` | 非公開店舗が一般利用者に見えない |
| 4-10 | 店舗更新リポジトリ | `repositories/shop-write.ts`（`updateShopAsOwner`） | **他人の店舗を更新できない** |
| 4-11 | 監査ログ | `lib/audit-log.ts` | admin 操作で必ず記録される |
| 4-12 | ルート + RPC 型 | `routes/shops.ts`, `AppType` export | モバイルから型が引けること |

## Phase 5: モバイル認証 + ロールルーティング（9 タスク）

| # | タスク | 成果物 |
|---|---|---|
| 5-1 | API クライアント | `lib/api-client.ts`（Hono RPC + セッション付与） |
| 5-2 | 認証クライアント | `lib/auth-client.ts`（Better Auth + expoClient + SecureStore） |
| 5-3 | 認証 Provider | `features/auth/auth-provider.tsx`, `use-session.ts` |
| 5-4 | ルートゲート | `app/_layout.tsx`, `app/index.tsx`（ロール → グループへリダイレクト） |
| 5-5 | `(auth)/welcome` | オンボーディング 3 スライド |
| 5-6 | `(auth)/sign-in` | フォーム + エラー表示 + テスト |
| 5-7 | `(auth)/sign-up` | フォーム + バリデーション + テスト |
| 5-8 | `(auth)/verify-email`, `forgot-password` | 2 画面 |
| 5-9 | ロール別レイアウト骨格 | `(user)/_layout.tsx`, `(owner)/_layout.tsx`, `(admin)/_layout.tsx` + タブ |

## Phase 6: 利用者コア（22 タスク）

| # | タスク |
|---|---|
| 6-1 | `features/shops/use-nearby-shops.ts`（位置情報取得 + 半径検索） |
| 6-2 | 位置情報パーミッション処理（拒否時の代替 UX） |
| 6-3 | `components/shop/shop-card.tsx` + テスト |
| 6-4 | `components/shop/open-status-badge.tsx` + テスト |
| 6-5 | `components/shop/rating-stars.tsx` + テスト |
| 6-6 | `(user)/(tabs)/index.tsx` ホーム |
| 6-7 | `components/map/shop-marker.tsx` / `cluster-marker.tsx` |
| 6-8 | `stores/map-viewport.ts`（Zustand） |
| 6-9 | `components/map/map-bottom-sheet.tsx`（3 段スナップ） |
| 6-10 | `components/map/search-this-area-button.tsx` |
| 6-11 | `(user)/(tabs)/map.tsx` 地図とシートの双方向同期 |
| 6-12 | `stores/search-filter.ts` + フィルタチップ |
| 6-13 | `(user)/(tabs)/search.tsx` 条件検索 |
| 6-14 | `components/shop/shop-hero-header.tsx`（折りたたみヘッダー） |
| 6-15 | `(user)/shop/[shopId]/index.tsx` 店舗詳細 |
| 6-16 | `(user)/shop/[shopId]/photos.tsx` ギャラリー |
| 6-17 | `(user)/shop/[shopId]/menu.tsx` |
| 6-18 | `components/review/rating-distribution.tsx` + `review-card.tsx` |
| 6-19 | `(user)/shop/[shopId]/reviews.tsx` |
| 6-20 | `components/review/star-rating-input.tsx` + 画像選択 |
| 6-21 | `(user)/review/new.tsx` + `[reviewId]/edit.tsx`（R2 アップロード） |
| 6-22 | お気に入り（`use-favorites.ts` + 楽観的更新）+ `(user)/(tabs)/saved.tsx` |

## Phase 7: 予約（13 タスク）

| # | タスク |
|---|---|
| 7-1 | `ReservationLock` Durable Object（枠の直列化） |
| 7-2 | 予約リポジトリ（作成 / 取得 / キャンセル）+ 権限テスト |
| 7-3 | 予約枠 API（`generateSlots` を利用） |
| 7-4 | 二重予約の並行テスト（同時リクエストで 1 件だけ成功すること） |
| 7-5 | 予約ルート + RPC 型 |
| 7-6 | `components/reservation/slot-picker.tsx` |
| 7-7 | `(user)/shop/[shopId]/reserve.tsx` |
| 7-8 | `(user)/reservations/index.tsx` |
| 7-9 | `(user)/reservations/[reservationId].tsx`（キャンセル） |
| 7-10 | 店舗側: 予約一覧 API（オーナー権限） |
| 7-11 | `(owner)/(tabs)/reservations.tsx` |
| 7-12 | `(owner)/reservations/[reservationId].tsx`（承認 / 拒否） |
| 7-13 | 予約ステータス変更の通知レコード作成 |

## Phase 8: 店舗管理者（19 タスク）

| # | タスク |
|---|---|
| 8-1 | 店舗申請 API + `shop_applications` リポジトリ |
| 8-2 | `(user)/settings/shop-application.tsx` |
| 8-3 | `(owner)/onboarding/apply.tsx` |
| 8-4 | `(owner)/onboarding/status.tsx` |
| 8-5 | KPI 集計 API（期間別 / 前期間比）+ KV キャッシュ |
| 8-6 | `components/chart/line-chart.tsx`（react-native-svg）+ テスト |
| 8-7 | `components/chart/kpi-card.tsx` + テスト |
| 8-8 | `(owner)/(tabs)/dashboard.tsx` |
| 8-9 | `(owner)/(tabs)/shop.tsx` ハブ |
| 8-10 | `(owner)/shop/basic.tsx` |
| 8-11 | `(owner)/shop/hours.tsx`（日跨ぎ入力 UI） |
| 8-12 | `(owner)/shop/location.tsx`（ピンドラッグ → geohash 再計算） |
| 8-13 | `(owner)/shop/photos.tsx`（並べ替え / カバー指定） |
| 8-14 | `(owner)/shop/seats.tsx` |
| 8-15 | メニュー API + 権限テスト |
| 8-16 | `(owner)/shop/menu/index.tsx` |
| 8-17 | `(owner)/shop/menu/[menuItemId].tsx` |
| 8-18 | レビュー返信 API + `(owner)/reviews/[reviewId]/reply.tsx` |
| 8-19 | `(owner)/(tabs)/reviews.tsx` + `campaigns/` 2 画面 |

## Phase 9: システム管理者（15 タスク）

| # | タスク |
|---|---|
| 9-1 | 審査 API（承認 / 差し戻し）+ ロール昇格 + 監査ログ |
| 9-2 | `(admin)/(tabs)/approvals.tsx` |
| 9-3 | `(admin)/approvals/[applicationId].tsx` |
| 9-4 | 通報 API（作成 / 解決 / 却下） |
| 9-5 | `(user)/report/[targetType]/[targetId].tsx` |
| 9-6 | `(admin)/(tabs)/reports.tsx` |
| 9-7 | `(admin)/reports/[reportId].tsx`（コンテンツ非表示化） |
| 9-8 | ユーザー管理 API（検索 / 停止 / ロール変更）+ 権限テスト |
| 9-9 | `(admin)/(tabs)/users.tsx` |
| 9-10 | `(admin)/users/[userId].tsx` |
| 9-11 | `(admin)/shops/[shopId].tsx`（強制非公開） |
| 9-12 | マスタ API + `(admin)/masters/genres.tsx` |
| 9-13 | `(admin)/masters/areas.tsx` |
| 9-14 | `(admin)/audit-log.tsx` |
| 9-15 | `(admin)/(tabs)/overview.tsx` + `announcements.tsx` |

## Phase 10: 仕上げ（10 タスク）

| # | タスク |
|---|---|
| 10-1 | プッシュ通知（expo-notifications + トークン登録 API） |
| 10-2 | 通知送信（予約承認 / レビュー返信）+ `(user)/notifications.tsx` |
| 10-3 | ディープリンク（店舗 / リスト共有） |
| 10-4 | 画面遷移アニメーションと触覚フィードバック |
| 10-5 | ダークモード全画面確認と修正 |
| 10-6 | エラーバウンダリと オフライン表示 |
| 10-7 | `apps/api` を Cloudflare へデプロイ |
| 10-8 | EAS ビルド設定（iOS / Android の開発ビルド） |
| 10-9 | README（スクリーンショット / アーキテクチャ図 / 設計判断の説明） |
| 10-10 | デモ動画と最終の全テスト実行 |
