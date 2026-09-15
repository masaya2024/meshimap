# MeshiMap 設計書

作成日: 2026-09-15 / 最終更新: 2026-09-15（バックエンドを Cloudflare に変更、TDD 方針を追加）

## 1. 何を作るか

地図を主役にしたグルメ発見・予約アプリ。食べログ / Google マップのグルメ機能を題材に、
**3 つのロールが 1 つのコードベースで共存する業務アプリ相当の設計**を示す。

ポートフォリオとしての主張は 4 点。

1. **ロール別アクセス制御を、忘れようがない形で型に埋め込める** — RLS のない D1 を選んだうえで、
   権限チェックの抜けをコンパイルエラーにするリポジトリ層を設計する
2. **制約のある環境で地理空間検索を成立させられる** — D1 に PostGIS も R*Tree もないことを理解した上で、
   geohash による候補絞り込み + アプリ層 Haversine という構成を選び、その根拠を説明できる
3. **テストが機能していることを機械的に証明できる** — TDD で書き、ミューテーションテストで
   「テストを通過するが間違っている実装」が存在しないことを検証する
4. **ネイティブ機能を使いこなせる** — 位置情報・地図クラスタリング・カメラ/画像アップロード・
   プッシュ通知・ディープリンク

## 2. 技術スタック（確定）

### モバイル

| 領域             | 採用                                                            | バージョン      |
| ---------------- | --------------------------------------------------------------- | --------------- |
| フレームワーク   | Expo（Dev Client + Prebuild による実機ネイティブビルド）        | SDK 57          |
| ランタイム       | React Native / React                                            | 0.86.3 / 19.2.3 |
| 言語             | TypeScript（strict + `noUncheckedIndexedAccess`）               | 6.0             |
| ルーティング     | expo-router（typed routes 有効）                                | 57              |
| スタイル         | NativeWind + Tailwind CSS                                       | 4.2.7 / 3.4.19  |
| フォント         | `@expo-google-fonts/outfit` / `@expo-google-fonts/noto-sans-jp` | 0.4.3           |
| アイコン         | `lucide-react-native` + `react-native-svg`                      | 1.46 / 15.15    |
| 地図             | `react-native-maps`                                             | 1.27.2          |
| サーバ状態       | TanStack Query                                                  | v5              |
| クライアント状態 | Zustand                                                         | v5              |
| フォーム         | React Hook Form + Zod                                           | 7.88 / 4.6      |
| ボトムシート     | `@gorhom/bottom-sheet`                                          | 5.2             |

### バックエンド（Cloudflare）

| 領域                   | 採用                                  | 役割                                            |
| ---------------------- | ------------------------------------- | ----------------------------------------------- |
| 実行環境               | Cloudflare Workers                    | API 本体                                        |
| フレームワーク         | Hono 4.13                             | ルーティング + RPC 型エクスポート               |
| DB                     | Cloudflare D1（SQLite）               | 店舗 / レビュー / 予約 / 認証                   |
| ORM                    | Drizzle ORM 0.45 + drizzle-kit        | スキーマ定義とマイグレーション生成              |
| 認証                   | Better Auth 1.7 + `@better-auth/expo` | セッション管理。モバイル側は SecureStore に保存 |
| オブジェクトストレージ | R2                                    | 店舗写真 / レビュー写真 / アバター              |
| KV                     | Workers KV                            | 集計キャッシュ（人気店ランキング等）            |
| 同時実行制御           | Durable Objects                       | 予約枠の二重押さえ防止（店舗ごとに直列化）      |
| デプロイ               | Wrangler 4.131                        |                                                 |

**型の共有**: Hono の RPC 機能（`hc<AppType>`）で API の型をそのままモバイル側へ流す。
API のレスポンス型を手で二重定義しない。

## 3. Cloudflare 採用にともなう設計上の制約と対処

Supabase(PostgreSQL) から Cloudflare(D1/SQLite) に変えたことで、2 つの前提が失われる。
どちらも「回避策を選んだ理由」まで説明できることが、この構成の価値になる。

### 3.1 地理空間拡張がない

**事実**: D1 はカスタム SQLite 拡張をサポートせず、R*Tree / Geopoly は利用できない
（[cloudflare/workers-sdk#9324](https://github.com/cloudflare/workers-sdk/issues/9324)）。
また D1 のドキュメントは Math functions をサポートと記載するが、
「allowlist されているがコンパイル時に有効化されていない」という報告があり
（[cloudflare/workerd#1245](https://github.com/cloudflare/workerd/issues/1245)）、
**SQL 内の三角関数に依存する設計は避ける**。

**対処** — 3 段構えで絞り込む。

```
[1] geohash プレフィックス検索   … SQL。B-tree インデックスが効く。候補を数十〜数百件に落とす
[2] 境界ボックスによる再フィルタ … SQL。lat/lng の単純な範囲比較のみ（数学関数不要）
[3] Haversine による厳密距離計算 … Worker 上の TypeScript。距離順ソートと半径の最終判定
```

`shops` テーブルは `lat` / `lng`（REAL）に加えて `geohash`（TEXT, precision 7 ≒ 152m 四方）を保持する。
半径検索では中心セルとその 8 近傍を求め、半径に応じた precision に切り詰めて
`WHERE geohash GLOB 'xn774c*' OR ...` の形で候補を取る。
[3] は候補件数ぶんの計算しか走らないため、Worker の CPU 時間内に十分収まる。

この [1][2][3] を担うのが `packages/geo`。**純粋関数のみで構成し、最も手厚くテストする。**

### 3.2 行レベルセキュリティ（RLS）がない

**事実**: D1 に RLS はない。権限チェックはすべてアプリケーション層の責務になる。

**対処** — 「チェックを書き忘れる」ことを型で防ぐ。リポジトリ層の関数は、
**権限主体を引数として要求する**シグネチャにする。

```ts
// 悪い例: 呼び出し側が権限チェックを忘れられる
updateShop(shopId: string, data: ShopUpdate): Promise<Shop>

// 採用する形: 「誰として」操作するかを渡さないとコンパイルが通らない
updateShopAsOwner(db: Db, actor: OwnerActor, shopId: ShopId, data: ShopUpdate): Promise<Shop>
//                           ^^^^^^^^^^^^^^ ブランド型。ミドルウェアでロール検証を通った証明としてのみ生成できる
```

`OwnerActor` / `AdminActor` は**ブランド型**にし、認証ミドルウェアの中でしか構築できないようにする
（コンストラクタを外部に公開しない）。これにより、
「ログインチェックは通したが所有者チェックを忘れた」経路が型レベルで存在しなくなる。

さらに `updateShopAsOwner` は SQL の `WHERE` 句に必ず `owner_id = ?` を含める。
所有者チェックはアプリの分岐ではなく**クエリ条件そのもの**として表現する。

## 4. ロール定義

| ロール         | 値      | できること                                                                       |
| -------------- | ------- | -------------------------------------------------------------------------------- |
| 利用者         | `user`  | 検索・閲覧・レビュー投稿・お気に入り・リスト作成・予約・通報                     |
| 店舗管理者     | `owner` | 自店舗の情報/メニュー/写真/営業時間/席の編集、予約の承認、レビュー返信、KPI 閲覧 |
| システム管理者 | `admin` | 店舗申請の審査、通報対応、ユーザーの停止、マスタ管理、全体 KPI、監査ログ閲覧     |

1 アカウント 1 ロール。ただし `user` から店舗申請を出し、審査通過で `owner` へ昇格する遷移は実装する。

## 5. ページ構成

`src/app` 直下でロールごとにグループを切り、ルート `_layout.tsx` の認証ゲートが
セッションのロールを見て該当グループへリダイレクトする。ロール外のルートには到達できない。

### 5.1 全体ツリー

```
apps/mobile/src/app/
├── _layout.tsx                        # Providers（Query/Auth/Theme）+ フォント読込 + スプラッシュ制御
├── index.tsx                          # ロール判定 → 各グループへリダイレクト
├── +not-found.tsx
│
├── (auth)/                            # ── 未認証 ───────────────────
│   ├── _layout.tsx
│   ├── welcome.tsx                    # オンボーディング（3 スライド + ゲスト利用導線）
│   ├── sign-in.tsx                    # メール / パスワード
│   ├── sign-up.tsx                    # 会員登録
│   ├── verify-email.tsx               # 確認メール送信後の待機
│   └── forgot-password.tsx            # パスワード再設定
│
├── (user)/                            # ── 利用者（24 画面）─────────
│   ├── _layout.tsx
│   ├── (tabs)/
│   │   ├── _layout.tsx                # 5 タブ
│   │   ├── index.tsx                  # ホーム：現在地周辺のおすすめ / 特集 / 履歴からの再訪提案
│   │   ├── map.tsx                    # ★主役：地図検索（クラスタ + ボトムシート + 絞り込み）
│   │   ├── search.tsx                 # 条件検索（キーワード / ジャンル / 予算 / 距離 / 評価 / 営業中）
│   │   ├── saved.tsx                  # 保存：お気に入り + 行きたいリスト
│   │   └── profile.tsx                # マイページ（投稿レビュー / 予約 / 設定入口）
│   ├── shop/[shopId]/
│   │   ├── index.tsx                  # 店舗詳細（ヒーロー写真 / 評価 / 営業状況 / 地図 / アクション）
│   │   ├── photos.tsx                 # 写真ギャラリー（全画面ビューア）
│   │   ├── menu.tsx                   # メニュー（カテゴリ別）
│   │   ├── reviews.tsx                # レビュー一覧（並び替え / 評価フィルタ）
│   │   └── reserve.tsx                # 予約フォーム（日付 / 時間枠 / 人数 / 要望）
│   ├── review/
│   │   ├── new.tsx                    # レビュー投稿（星 / 本文 / 写真複数 / 訪問日 / 予算）
│   │   └── [reviewId]/edit.tsx        # レビュー編集・削除
│   ├── reservations/
│   │   ├── index.tsx                  # 予約一覧（今後 / 過去）
│   │   └── [reservationId].tsx        # 予約詳細（キャンセル / 経路案内）
│   ├── lists/
│   │   ├── index.tsx                  # 行きたいリスト一覧
│   │   ├── new.tsx                    # リスト作成
│   │   └── [listId].tsx               # リスト詳細（地図表示 / 並べ替え / 共有）
│   ├── notifications.tsx              # 通知センター
│   ├── report/[targetType]/[targetId].tsx  # 通報フォーム（店舗 / レビュー 共用）
│   └── settings/
│       ├── index.tsx                  # 設定トップ
│       ├── profile-edit.tsx           # プロフィール編集（アバターアップロード）
│       ├── notifications.tsx          # 通知設定
│       ├── shop-application.tsx       # 店舗申請（→ owner へのロール遷移入口）
│       └── account.tsx                # パスワード変更 / ログアウト / 退会
│
├── (owner)/                           # ── 店舗管理者（18 画面）─────
│   ├── _layout.tsx
│   ├── (tabs)/
│   │   ├── _layout.tsx                # 5 タブ
│   │   ├── dashboard.tsx              # KPI（閲覧数 / 保存数 / 予約数 / 平均評価の推移グラフ）
│   │   ├── reservations.tsx           # 予約管理（日付別 / ステータス別 / 承認・拒否）
│   │   ├── shop.tsx                   # 店舗情報ハブ（各編集画面への入口 + 公開プレビュー）
│   │   ├── reviews.tsx                # レビュー管理（未返信バッジ / 返信 / 通報申請）
│   │   └── account.tsx                # アカウント
│   ├── shop/
│   │   ├── basic.tsx                  # 基本情報（店名 / ジャンル / 予算帯 / 電話 / 説明）
│   │   ├── hours.tsx                  # 営業時間・定休日・臨時休業
│   │   ├── location.tsx               # 住所 + 地図上でピンをドラッグして緯度経度を確定
│   │   ├── photos.tsx                 # 写真管理（追加 / 並べ替え / カバー指定）
│   │   ├── seats.tsx                  # 席数・予約受付設定（枠の長さ / 同時受付数 / 受付停止）
│   │   └── menu/
│   │       ├── index.tsx              # メニュー一覧（カテゴリ別・並べ替え）
│   │       └── [menuItemId].tsx       # メニュー編集（新規は `new`）
│   ├── reservations/[reservationId].tsx  # 予約詳細（承認 / 拒否 / メモ / 来店記録）
│   ├── reviews/[reviewId]/reply.tsx   # レビュー返信
│   ├── campaigns/
│   │   ├── index.tsx                  # クーポン一覧
│   │   └── [campaignId].tsx           # クーポン編集
│   └── onboarding/
│       ├── apply.tsx                  # 店舗申請フォーム（書類アップロード含む）
│       └── status.tsx                 # 審査ステータス（審査中 / 差し戻し理由 / 再提出）
│
└── (admin)/                           # ── システム管理者（14 画面）──
    ├── _layout.tsx
    ├── (tabs)/
    │   ├── _layout.tsx                # 5 タブ
    │   ├── overview.tsx               # 全体 KPI（新規店舗 / 投稿数 / 未処理件数）
    │   ├── approvals.tsx              # 店舗申請の審査キュー
    │   ├── reports.tsx                # 通報キュー（レビュー / 店舗 / ユーザー）
    │   ├── users.tsx                  # ユーザー検索・一覧
    │   └── more.tsx                   # マスタ管理・監査ログ・お知らせへの入口
    ├── approvals/[applicationId].tsx  # 申請詳細（提出書類確認 / 承認 / 差し戻し理由入力）
    ├── reports/[reportId].tsx         # 通報詳細（対象コンテンツ表示 / 非表示 / 却下 / 警告）
    ├── users/[userId].tsx             # ユーザー詳細（投稿履歴 / 停止 / ロール変更）
    ├── shops/[shopId].tsx             # 店舗詳細（強制非公開 / オーナー付け替え）
    ├── masters/
    │   ├── genres.tsx                 # ジャンルマスタ CRUD
    │   └── areas.tsx                  # エリアマスタ CRUD
    ├── announcements.tsx              # 全体お知らせ配信
    └── audit-log.tsx                  # 監査ログ（誰がいつ何をしたか）
```

合計 **61 画面**（認証 5 / 利用者 24 / 店舗管理者 18 / システム管理者 14）。

### 5.2 作り込みを集中させる 3 画面

**利用者 / 地図検索（`(user)/(tabs)/map.tsx`）**

- 全画面地図 + 3 段階スナップのボトムシート（peek / half / full）
- ズームレベル連動のマーカークラスタリング（グリッド方式。`packages/geo` に実装しテスト）
- 地図移動で「このエリアを再検索」を表示 → 境界ボックスで再クエリ（debounce 500ms）
- 上部に横スクロールのフィルタチップ（営業中 / ジャンル / 予算 / 評価 4.0+）
- ピン選択でシートが該当カードへスクロール、カード選択で地図がその店へ移動（双方向同期）

**利用者 / 店舗詳細（`(user)/shop/[shopId]/index.tsx`）**

- スクロール連動の折りたたみヘッダー（写真パララックス → タイトルバーへ収束）
- 「営業中 / まもなく閉店 / 本日定休」を営業時間テーブルから算出（`packages/core`）
- 下部固定のアクションバー（予約する / 電話 / 経路）
- レビューサマリ（評価分布バー）+ 直近 3 件 + 店舗からの返信

**店舗管理者 / ダッシュボード（`(owner)/(tabs)/dashboard.tsx`）**

- 期間切替（7 / 30 / 90 日）の KPI カード 4 枚（前期間比の増減付き）
- `react-native-svg` で自作した折れ線グラフ
- 「未対応」セクション（未承認の予約、未返信のレビュー）から直接遷移

## 6. データモデル（D1 / SQLite）

Drizzle でスキーマを定義し、`drizzle-kit generate` で `migrations/*.sql` を生成、
`wrangler d1 migrations apply` で適用する。

```
-- 認証（Better Auth が管理）
user                id, email, email_verified, name, image, created_at, updated_at
session             id, user_id, token, expires_at, ip_address, user_agent
account             id, user_id, provider_id, password, ...
verification        id, identifier, value, expires_at

-- アプリ
profiles            user_id(PK, → user.id), role, display_name, avatar_key, bio, status, created_at
genres              id, name, slug, icon_key, sort_order
areas               id, name, parent_id, prefecture
shops               id, owner_id, name, name_kana, genre_id, area_id, description,
                    postal_code, address,
                    lat REAL, lng REAL, geohash TEXT,          -- ← 3.1 の地理空間検索用
                    phone, website, budget_lunch_min/max, budget_dinner_min/max,
                    status, rating_avg, rating_count, view_count, created_at, updated_at
shop_hours          id, shop_id, day_of_week(0-6), open_minute, close_minute, is_closed
                                                              -- ← 分単位 int。日跨ぎは close > 1440 で表現
shop_closures       id, shop_id, date, reason                 -- 臨時休業
shop_photos         id, shop_id, r2_key, caption, sort_order, is_cover
menu_categories     id, shop_id, name, sort_order
menu_items          id, shop_id, category_id, name, price, description, r2_key, is_recommended
seat_settings       shop_id(PK), capacity, slot_minutes, max_parallel, accepts_reservation
reservations        id, shop_id, user_id, reserved_at, party_size, note, status, created_at
reviews             id, shop_id, user_id, rating(1-5), body, visited_on, budget, status, created_at
review_photos       id, review_id, r2_key, sort_order
review_replies      review_id(PK), shop_id, body, created_at
favorites           user_id + shop_id (複合PK), created_at
lists               id, user_id, name, description, is_public, share_token
list_items          list_id + shop_id (複合PK), note, sort_order
reports             id, reporter_id, target_type, target_id, reason, detail, status, handled_by, handled_at
shop_applications   id, applicant_id, shop_id, documents(JSON), status, reviewed_by, review_note
notifications       id, user_id, type, title, body, data(JSON), read_at, created_at
audit_logs          id, actor_id, action, target_type, target_id, diff(JSON), created_at
```

**インデックス方針**

- `shops(geohash)` — 半径検索の第 1 段（最重要）
- `shops(lat, lng)` — 境界ボックスの第 2 段
- `shops(genre_id, status)`, `shops(area_id, status)` — 一覧の絞り込み
- `reviews(shop_id, created_at DESC)`, `reservations(shop_id, reserved_at)`
- 全文検索は FTS5（D1 がサポート）で `shops_fts` 仮想テーブルを作り、店名・説明を対象にする

**営業時間を分単位の整数で持つ理由**: `"22:00"` のような文字列比較は日跨ぎ営業（25:30 閉店）を
表現できない。開店 1080 / 閉店 1530（= 翌 01:30）のように分で持てば、
日跨ぎ判定が単純な数値比較になり、テストも書きやすい。

## 7. ディレクトリ構成（モノレポ）

npm workspaces。Expo SDK 52 以降はモノレポを自動検出するため Metro の手動設定は不要。

```
meshimap/
├── apps/
│   ├── mobile/                  # Expo アプリ
│   │   └── src/
│   │       ├── app/             # 画面（ルーティングと組み立てのみ。ロジックを置かない）
│   │       ├── components/
│   │       │   ├── ui/          # 汎用プリミティブ（Button, Card, Badge, Input, Sheet, Skeleton, EmptyState）
│   │       │   ├── shop/        # 店舗ドメイン（ShopCard, ShopHeroHeader, OpenStatusBadge, RatingBar）
│   │       │   ├── map/         # 地図（ClusterMarker, ShopMarker, SearchThisAreaButton, MapBottomSheet）
│   │       │   ├── review/      # レビュー（ReviewCard, StarRatingInput, RatingDistribution）
│   │       │   └── chart/       # react-native-svg 製グラフ（LineChart, KpiCard）
│   │       ├── features/        # ドメインごとの hooks + API 呼び出し（画面はここだけを呼ぶ）
│   │       │   ├── auth/  shops/  reviews/  reservations/  favorites/  owner/  admin/
│   │       ├── lib/             # api-client, query-client, storage, format
│   │       ├── constants/       # theme, config（マジックナンバーは全てここ）
│   │       ├── hooks/           # 汎用 hooks
│   │       └── stores/          # Zustand（search-filter, map-viewport）
│   │
│   └── api/                     # Cloudflare Workers
│       └── src/
│           ├── index.ts         # Hono アプリのエントリ。AppType を export
│           ├── routes/          # エンドポイント（薄く保つ）
│           ├── repositories/    # DB アクセス。権限主体を引数に要求する（3.2）
│           ├── middleware/      # auth, role-guard, error-handler
│           ├── db/              # schema.ts, client.ts
│           └── lib/             # r2, audit-log
│
├── packages/
│   ├── geo/                     # geohash / Haversine / 境界ボックス / クラスタリング
│   └── core/                    # ロール定義 / 営業時間判定 / 予約枠算出 / 評価集計 / Zod スキーマ
│
└── docs/
```

`packages/geo` と `packages/core` は**純粋関数のみ**。I/O を持たないため単体テストが容易で、
ミューテーションテストの対象として最適。ここにアプリの「判断」を集約する。

## 8. 命名規則・コーディング規約

詳細は `docs/CODING_GUIDELINES.md`。要点のみ。

| 対象                         | 規則                                   | 例                                           |
| ---------------------------- | -------------------------------------- | -------------------------------------------- |
| ファイル・ディレクトリ       | kebab-case                             | `shop-card.tsx`, `business-hours.ts`         |
| React コンポーネント         | PascalCase                             | `ShopCard`, `OpenStatusBadge`                |
| 関数・変数                   | camelCase                              | `calculateDistance`, `isCurrentlyOpen`       |
| 定数                         | UPPER_SNAKE_CASE                       | `DEFAULT_SEARCH_RADIUS_M`, `MAX_PHOTO_COUNT` |
| 型・インターフェース         | PascalCase（`I` 接頭辞なし）           | `Shop`, `ReservationStatus`                  |
| Zod スキーマ                 | `<名前>Schema`                         | `shopCreateSchema`                           |
| カスタムフック               | `use` + camelCase                      | `useNearbyShops`                             |
| 真偽値                       | `is` / `has` / `can` / `should` 接頭辞 | `isOpen`, `hasReplied`, `canReserve`         |
| DB カラム                    | snake_case（SQLite 慣習）              | `owner_id`, `rating_avg`                     |
| expo-router の動的セグメント | 具体名（`[id]` を使わない）            | `[shopId]`, `[reviewId]`                     |

**禁止**（CI で検出する）

- `any`（`unknown` + 絞り込みを使う）
- `console.log`（ロガー経由にする）
- マジックナンバー・マジックストリング（`constants/` に定数として定義）
- 未使用の import / 変数（`noUnusedLocals` / `noUnusedParameters` で検出）
- 根拠のない `// TODO`（Issue 番号かコンテキストを併記する）

## 9. コンポーネント設計方針

**3 層に分ける。**

1. **`components/ui/`（プリミティブ）** — ドメインを知らない。`Button`, `Card`, `Input`, `Badge`,
   `Skeleton`, `EmptyState`, `Sheet`。props でのみ振る舞いが決まり、API も状態管理も参照しない。
2. **`components/<domain>/`（ドメインコンポーネント）** — ドメイン型を受け取って表示する。
   `ShopCard` は `Shop` を props で受け取るだけで、自分でデータを取りに行かない。
3. **`app/`（画面）** — `features/` の hooks でデータを取り、上記を組み立てる。

**規則**

- データ取得は `features/*/use-*.ts` に閉じる。コンポーネントから直接 `fetch` しない
- プリミティブは variant を props で受ける（`<Button variant="primary" size="lg" />`）。
  スタイルの分岐を呼び出し側に散らさない
- 3 箇所以上で同じ JSX が現れたらプリミティブへ昇格させる
- 1 ファイル 1 コンポーネント。200 行を超えたら分割を検討する
- 全リスト画面に **loading / empty / error** の 3 状態を必ず用意する
  （`Skeleton` と `EmptyState` をプリミティブ化しているのはこのため）

## 10. デザイン方針

- **配色**: 炭火のオレンジレッド（primary `#E2553D`）を基調に、背景はウォームグレー。ダークモード対応。
  評価は琥珀、営業中は緑、閉店は中立グレー。
- **タイポグラフィ**: 見出しと数値は Outfit（評価点や価格が締まる）、日本語本文は Noto Sans JP。
  Tailwind の `font-display` / `font-body` に割り当てる。
- **角丸・影**: カードは `rounded-2xl`。影は薄く、階層は境界線で作る。

## 11. テスト戦略

**TDD（Red → Green → Refactor）で書く。** 実装より先に、失敗するテストを書く。

### 11.1 サイクル

1. **Red** — これから作る振る舞いのテストを書き、**実行して失敗することを確認する**。
   失敗を見ずに次へ進まない（テスト自体が壊れていても気づけないため）
2. **Green** — テストを通す最小限の実装を書く
3. **Refactor** — テストが緑のまま整理する

### 11.2 「テストが本当に機能しているか」を検証する

TDD だけでは「テストは通るが実装が間違っている」を防げない。そこで
**ミューテーションテスト（Stryker）**を導入する。

Stryker は実装コードを機械的に書き換え（`>` を `>=` に、`+` を `-` に、条件を `true` に固定するなど）、
**その改変版でテストが落ちるか**を確認する。落ちなければ、そのテストは
その挙動を検証できていないということになる。

```
mutation score = 検知できた改変数 / 生存しなかった改変の総数
```

`packages/geo` と `packages/core` に対して実行し、**スコア 85% を下回ったら CI を失敗させる**
（`stryker.config.json` の `thresholds.break: 85`）。

これは「テストを書きました」ではなく「**テストが実際に間違いを捕まえられることを証明しました**」
と言える状態を作るための仕組み。

### 11.3 レイヤ別の方針

| 対象                         | ツール                              | 方針                                                                   |
| ---------------------------- | ----------------------------------- | ---------------------------------------------------------------------- |
| `packages/geo`               | Vitest + Stryker                    | カバレッジ 100% 必須。境界値（日付変更線、極付近、半径 0）を網羅       |
| `packages/core`              | Vitest + Stryker                    | 同上。営業時間の日跨ぎ、予約枠の端、評価の丸めを重点的に               |
| `apps/api` リポジトリ層      | Vitest                              | **権限テストを最優先**。「他人の店舗を更新できないこと」を全操作で検証 |
| `apps/api` ルート            | Vitest                              | ロール別に 401 / 403 / 200 を検証                                      |
| `apps/mobile` コンポーネント | Jest + React Native Testing Library | プリミティブと主要ドメインコンポーネント                               |
| `apps/mobile` hooks          | Jest                                | TanStack Query のキャッシュ・楽観的更新の挙動                          |

### 11.4 回帰テスト

- 機能追加時: 新機能のテスト + 関連する既存機能のテストを両方実行する
- バグ修正時: **まず失敗する再現テストを書く**（Red）→ 修正（Green）。このテストは恒久的に残す
- 完了の定義: `npm test` が全ワークスペースで通り、`npm run test:mutation` が閾値を満たすこと

## 12. 実装フェーズ

| Phase | 内容                                                                   | 到達点                           |
| ----- | ---------------------------------------------------------------------- | -------------------------------- |
| 0     | モノレポ基盤 / NativeWind / フォント / テーマ / UI プリミティブ        | デザインシステムが動く           |
| 1     | `packages/geo` を TDD で実装（geohash / Haversine / bbox / クラスタ）  | ミューテーションスコア 85%+      |
| 2     | `packages/core` を TDD で実装（営業時間 / 予約枠 / 評価 / スキーマ）   | 同上                             |
| 3     | D1 スキーマ + マイグレーション + シード（東京都内に店舗 60 件）        | データが引ける                   |
| 4     | API 基盤（Hono / 認証 / ロールガード / ブランド型 Actor / 権限テスト） | 権限の抜けがないことを証明できる |
| 5     | 認証 + ロールルーティング（モバイル）                                  | 3 ロールでログイン分岐する       |
| 6     | 利用者コア（地図 / 検索 / 店舗詳細 / レビュー / お気に入り）           | **デモ可能な状態**               |
| 7     | 予約（利用者側 + 店舗側の承認フロー + Durable Objects）                | 双方向のフローが動く             |
| 8     | 店舗管理者（ダッシュボード / 店舗編集 / メニュー / レビュー返信）      | 管理アプリとして成立             |
| 9     | システム管理者（審査 / 通報 / ユーザー管理 / 監査ログ）                | 3 ロール完成                     |
| 10    | 仕上げ（通知 / ディープリンク / アニメーション / README / デモ動画）   | 提出可能                         |

Phase 6 到達時点で「動くポートフォリオ」として成立する。以降は積み増し。
