# MeshiMap コーディング規約

実装中に迷ったらここを見る。設計の背景は `docs/superpowers/specs/2026-09-15-meshimap-design.md`。

## 1. 命名規則

### 1.1 ファイル・ディレクトリ

**すべて kebab-case。** 例外なし。

```
components/shop/shop-card.tsx          ✅
components/shop/ShopCard.tsx           ❌
lib/business-hours.ts                  ✅
lib/businessHours.ts                   ❌
features/reservations/use-create-reservation.ts   ✅
```

expo-router の動的セグメントは **具体的な名前**にする。`[id]` は何の id か分からない。

```
app/(user)/shop/[shopId]/index.tsx     ✅
app/(user)/shop/[id]/index.tsx         ❌
```

### 1.2 コード内の識別子

| 対象 | 規則 | 例 |
|---|---|---|
| React コンポーネント | PascalCase | `ShopCard`, `OpenStatusBadge` |
| 関数・変数 | camelCase | `calculateDistance`, `nearbyShops` |
| 定数 | UPPER_SNAKE_CASE | `DEFAULT_SEARCH_RADIUS_M` |
| 型・インターフェース | PascalCase（`I` 接頭辞なし） | `Shop`, `ReservationStatus` |
| 型パラメータ | 意味のある名前 | `<TPayload>`（`<T>` は自明な場合のみ） |
| Zod スキーマ | `<名前>Schema` | `shopCreateSchema` |
| カスタムフック | `use` + camelCase | `useNearbyShops` |
| Zustand ストア | `use<名前>Store` | `useMapViewportStore` |
| DB テーブル・カラム | snake_case | `shop_hours`, `owner_id` |
| R2 オブジェクトキー | `<種別>/<id>/<uuid>.<ext>` | `shop-photos/shp_01.../a1b2.webp` |

### 1.3 真偽値

`is` / `has` / `can` / `should` のいずれかで始める。

```ts
const isOpen = ...           ✅
const hasReplied = ...       ✅
const canReserve = ...       ✅
const open = ...             ❌ 名詞か形容詞か分からない
const flag = ...             ❌
```

### 1.4 単位を名前に入れる

数値の単位は**必ず**名前に含める。距離・時間で最も事故が起きる。

```ts
const radiusM = 1000;              ✅ メートル
const slotMinutes = 90;            ✅ 分
const DEFAULT_TIMEOUT_MS = 5000;   ✅ ミリ秒
const radius = 1000;               ❌ km? m?
```

### 1.5 略語を使わない

ループカウンタ（`i`）と、広く通用する略語（`id`, `url`, `api`, `db`）のみ許可。

```ts
const reservation = ...      ✅
const rsv = ...              ❌
const shopCount = ...        ✅
const cnt = ...              ❌
```

## 2. 禁止パターン

CI（`typecheck` / lint）で機械的に検出する。

| 禁止 | 代わりに |
|---|---|
| `any` | `unknown` + 型ガードで絞り込む。外部データは Zod で parse する |
| `as` による型アサーション | 型ガード関数（`isShop(x): x is Shop`）を書く。ブランド型生成時のみ例外的に許可 |
| `console.log` | `lib/logger.ts` 経由。本番ビルドで除去される |
| マジックナンバー / マジックストリング | `constants/` に定数として定義する |
| 未使用の import / 変数 | 削除する（`noUnusedLocals` / `noUnusedParameters`） |
| 根拠のない `// TODO` | Issue 番号か理由を併記する（`// TODO(#42): ...`） |
| `!` による non-null アサーション | 早期 return か、`noUncheckedIndexedAccess` に沿った分岐で処理する |
| デフォルトエクスポート | 名前付きエクスポート。ただし expo-router の画面ファイルは仕様上 default が必須 |

## 3. コンポーネント設計

### 3.1 3 層構造

```
components/ui/        プリミティブ    ドメインを知らない。props だけで決まる
components/<domain>/  ドメイン        ドメイン型を受け取って表示する。データは取りに行かない
app/                  画面            features/ の hooks でデータを取り、上の 2 つを組み立てる
```

**依存の向きは一方通行**。`components/ui/` は何にも依存しない。`components/<domain>/` は
`ui` と型にのみ依存する。`app/` は全部に依存してよい。逆向きの import は禁止。

### 3.2 データ取得の場所

```tsx
// ❌ コンポーネントが自分でデータを取る
function ShopCard({ shopId }: { shopId: string }) {
  const { data } = useQuery({ queryKey: ['shop', shopId], queryFn: () => fetchShop(shopId) });
  ...
}

// ✅ 表示に徹する。データは呼び出し側から渡ってくる
function ShopCard({ shop, distanceM }: ShopCardProps) { ... }
```

`fetch` を直接呼んでよいのは `features/*/api.ts` だけ。コンポーネントからは呼ばない。

### 3.3 variant は props で受ける

スタイルの分岐を呼び出し側に散らさない。

```tsx
// ✅
<Button variant="primary" size="lg">予約する</Button>

// ❌ 呼び出し側が毎回 className を組み立てる
<Button className="bg-primary px-6 py-4 rounded-2xl">予約する</Button>
```

### 3.4 分割の基準

- 同じ JSX が 3 箇所以上に現れたらプリミティブへ昇格させる
- 1 ファイル 1 コンポーネント
- 200 行を超えたら分割を検討する（機械的な上限ではなく、責務を見直す合図）
- props が 8 個を超えたら、オブジェクトにまとめるか分割する

### 3.5 リストの 3 状態

データを表示する画面では **loading / empty / error** を必ず用意する。

```tsx
if (isPending) return <ShopListSkeleton />;
if (error) return <ErrorState onRetry={refetch} />;
if (shops.length === 0) return <EmptyState icon={MapPin} title="この条件のお店は見つかりませんでした" />;
```

## 4. 型の扱い

### 4.1 ID はブランド型にする

`string` 同士は取り違えてもコンパイルが通る。ID は区別する。

```ts
type ShopId = string & { readonly __brand: 'ShopId' };
type UserId = string & { readonly __brand: 'UserId' };

// これがコンパイルエラーになる
getShop(userId);  // Error: UserId is not assignable to ShopId
```

### 4.2 権限主体もブランド型にする

認証ミドルウェアの中でしか生成できない `OwnerActor` / `AdminActor` を作り、
権限が必要な操作はこれを引数に要求する。詳細は設計書 3.2。

### 4.3 外部から来るデータは必ず parse する

API レスポンス・フォーム入力・ディープリンクのパラメータは Zod で parse してから使う。
`as` でキャストしない。

## 5. コメント

- **日本語で書く**
- 「何をしているか」ではなく「**なぜそうしているか**」を書く

```ts
// ❌ コードを読めば分かる
// shops を距離順にソートする
shops.sort((a, b) => a.distanceM - b.distanceM);

// ✅ 判断の理由が残る
// D1 に距離計算関数がないため、候補を絞ったあとアプリ側で厳密距離を出してソートする
shops.sort((a, b) => a.distanceM - b.distanceM);
```

- 非自明な定数には根拠を添える

```ts
/** geohash precision 7 は約 152m 四方。徒歩圏（〜1km）の検索で候補が数十件に収まる粒度 */
const GEOHASH_PRECISION_WALKING = 7;
```

## 6. テスト

詳細は設計書 11 章。実装時の規則のみ。

### 6.1 TDD を守る

1. テストを書く
2. **実行して失敗することを確認する**（ここを飛ばさない）
3. 通す最小限の実装を書く
4. 緑のまま整理する

失敗を確認しないと、テスト自体が壊れていた場合に気づけない。

### 6.2 テスト名は日本語で振る舞いを書く

```ts
describe('isCurrentlyOpen', () => {
  it('営業時間内なら true を返す', () => { ... });
  it('日跨ぎ営業（25:30 閉店）で 翌 01:00 は営業中と判定する', () => { ... });
  it('臨時休業日は営業時間内でも false を返す', () => { ... });
});
```

### 6.3 境界値を必ず書く

「ちょうど」の値でバグが出る。開店時刻ちょうど、閉店時刻ちょうど、半径 0、
日付変更線、評価の丸め（4.45 → 4.5 か 4.4 か）。

### 6.4 バグ修正は再現テストから

修正前に、そのバグで**失敗するテスト**を書く。これが回帰テストとして恒久的に残る。
