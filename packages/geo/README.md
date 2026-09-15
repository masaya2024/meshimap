# @meshimap/geo

D1（SQLite）が PostGIS や R*Tree を持たないという制約を、純粋関数だけで埋める地理計算パッケージ。

## 設計方針

- **副作用・外部依存ゼロ。** Cloudflare Workers（`apps/api`）と Expo アプリ（`apps/mobile`）の両方から同じコードを使う。`dependencies` は空のまま維持する。
- **ブランド型で入口を絞る。** `Latitude` / `Longitude` / `Geohash` は専用ファクトリ経由でしか作れない。範囲チェックの迂回路を作らないことで、不正な値がドメインへ入るのをコンパイル時に防ぐ。
- **カバレッジ 100% + ミューテーションスコア 85% 以上を CI の必須条件にする。**

## 3 段階の近傍検索

D1 には `ST_DWithin` が無く、SQLite の三角関数も環境差があるため、SQL 側で距離計算をしない設計にした。

| 段  | 使う関数         | SQL / TS                                                       | 役割                                   |
| --- | ---------------- | -------------------------------------------------------------- | -------------------------------------- |
| 1   | `cellsForRadius` | `WHERE (geohash >= ? AND geohash < ?) OR …`                    | B-tree インデックスで数万件 → 数百件へ |
| 2   | `boundingBox`    | `WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?` | 矩形で数百件 → 数十件へ                |
| 3   | `distanceMeters` | Worker の TypeScript                                           | 正確な円内判定と距離順ソート           |

`cellsForRadius` が返す 3×3 セルで半径の円を確実に覆えるよう、精度の閾値は日本国内（緯度 24〜46 度）のセル最小辺を実測して決めている。

第 1 段を `IN` で書いてはいけない。`shops.geohash` は精度 7 固定で保存されるのに対し、
`cellsForRadius` は半径に応じて精度 3〜7 のセルを返すので、桁数が違う以上 `IN` は等値比較として
成立しない。渋谷（35.658034, 139.701636、保存値 `xn76fgr`）での実測:

| 半径    | 返るセル  | 桁数 | `IN` で一致 | 前方一致 |
| ------- | --------- | ---- | ----------- | -------- |
| 100m    | `xn76fgr` | 7    | する        | する     |
| 600m    | `xn76fg`  | 6    | しない      | する     |
| 3,000m  | `xn76f`   | 5    | しない      | する     |
| 19,000m | `xn76`    | 4    | しない      | する     |
| 50,000m | `xn7`     | 3    | しない      | する     |

前方一致の書き方は `GLOB` でも**範囲比較**でも索引は効く。採用するのは範囲比較。
`EXPLAIN QUERY PLAN` の実測（60 件の shops、`idx_shops_geohash` / `idx_shops_status_geohash` あり、
`ANALYZE` 済み。再現テストは `apps/api/src/db/schema/shop.test.ts`）:

| WHERE 句                                           | プラン                                              |
| -------------------------------------------------- | --------------------------------------------------- |
| `geohash GLOB 'xn76fg*'`（リテラル）               | SEARCH shops USING INDEX idx_shops_geohash          |
| `geohash GLOB ?` に `'xn76fg*'` をバインド         | SEARCH shops USING INDEX idx_shops_geohash          |
| `geohash GLOB ?` に `NULL` をバインド              | **SCAN shops**                                      |
| `geohash GLOB ?` に `'*fg*'`（先頭ワイルドカード） | **SCAN shops**                                      |
| `geohash GLOB ? \|\| '*'`                          | **SCAN shops**                                      |
| `geohash LIKE ?`                                   | **SCAN shops**                                      |
| `substr(geohash,1,6) IN (?,?,?)`                   | **SCAN shops**                                      |
| `geohash >= ? AND geohash < ?`                     | SEARCH shops USING INDEX idx_shops_geohash          |
| `status = ?` + 9 セルの `GLOB ?` を `OR`           | MULTI-INDEX OR（9 本とも idx_shops_status_geohash） |
| `status = ?` + 9 セルの範囲比較を `OR`             | MULTI-INDEX OR（9 本とも idx_shops_status_geohash） |

`GLOB` がバインド変数でも索引を使えるのは、SQLite の LIKE 最適化が
「パターンが実行時に前方一致だと分かれば範囲制約へ書き換える」仕組みだから。
プランに出る `(geohash>? AND geohash<?)` がその書き換えの跡で、実体は範囲比較と同じものになる。

それでも範囲比較を選ぶ理由は 2 つ:

1. **索引が効くかどうかがバインド値に左右されない。** 上の表のとおり `GLOB ?` は
   `NULL` や先頭ワイルドカードを渡された瞬間に全表走査へ落ちる。範囲比較は値に関係なく必ず索引を使う。
2. **Drizzle にそのまま書ける。** `drizzle-orm` は `glob` ヘルパを持たない（`like` はある）ので
   `GLOB` を使うと生 SQL テンプレートが要る。範囲比較なら `gte` / `lt` で書ける。

`LIKE` は使えない。SQLite の LIKE 最適化は既定の `case_sensitive_like=OFF` では働かないため、
リテラルでもバインド変数でも全表走査になる。

範囲の上限はセル文字列の末尾に `{`（U+007B）を足した値にする。geohash の
アルファベットは `0-9bcdefghjkmnpqrstuvwxyz` で最大が `z`（U+007A）であり、
`shops` の `ck_shops_geohash_alphabet` 制約がこれを保証しているため、
`{` は後続しうるどの文字より必ず大きい。列は `COLLATE` 指定の無い TEXT なので
比較は BINARY で行われる。実測でも `GLOB 'xn76fg*'` と
`>= 'xn76fg' AND < 'xn76fg{'` は同じ 60 件を返した。

第 2 段の矩形は日付変更線を跨ぐと `longitudeMin > longitudeMax` になる。SQL の `BETWEEN` は
この形を扱えないため、跨ぐ場合は `longitude >= ? OR longitude <= ?` の 2 条件へ展開する。
TypeScript 側の判定には `isWithinBounds` を使えば、跨ぎの有無を呼び出し側で意識せずに済む。

## 使い方

```ts
import {
  boundingBox,
  cellsForRadius,
  coordinate,
  distanceMeters,
  formatDistance,
} from '@meshimap/geo';

const center = coordinate(35.689592, 139.700413);
const cells = cellsForRadius(center, 1000); // D1 の前方一致（範囲比較）の OR 句へ
const bounds = boundingBox(center, 1000); // D1 の BETWEEN 句へ
const distance = distanceMeters(center, shop.location);
const label = formatDistance(distance); // "850m" / "1.2km"
```

## テスト

```bash
npm run test -w @meshimap/geo            # 単体テスト
npm run test:coverage -w @meshimap/geo   # カバレッジ（閾値 100%）
npm run test:mutation -w @meshimap/geo   # ミューテーションテスト（閾値 85%）
```

### ミューテーションテストが `command` ランナーである理由

`@stryker-mutator/vitest-runner` 10.0.0 は Vitest 5.0.0 と組み合わせると、
変異実行フェーズで 1 件もテストを走らせない（`Ran 0.00 tests per mutant on average.`）。
その結果すべての変異が `Survived` と誤判定され、スコアが実態より大幅に低く出る。

同じサンドボックスに対して `createVitest` を直接叩くと変異は正しく検知されるため、
テスト側ではなくランナー側の不具合である。回避策として、変異 ID を
`__STRYKER_ACTIVE_MUTANT__` 環境変数で受け渡す `command` ランナーを使っている。
`command` ランナーは変異ごとの絞り込み（`coverageAnalysis: "perTest"`）に対応しないため
`"off"` にしているが、全 346 変異でも実行は 1 分以内に収まる。

`@stryker-mutator/vitest-runner` が Vitest 5 に対応したら `testRunner` を `vitest` へ、
`coverageAnalysis` を `perTest` へ戻してよい。
