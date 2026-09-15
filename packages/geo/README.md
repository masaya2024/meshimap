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
| 1   | `cellsForRadius` | `WHERE geohash IN (?, …)`                                      | B-tree インデックスで数万件 → 数百件へ |
| 2   | `boundingBox`    | `WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?` | 矩形で数百件 → 数十件へ                |
| 3   | `distanceMeters` | Worker の TypeScript                                           | 正確な円内判定と距離順ソート           |

`cellsForRadius` が返す 3×3 セルで半径の円を確実に覆えるよう、精度の閾値は日本国内（緯度 24〜46 度）のセル最小辺を実測して決めている。

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
const cells = cellsForRadius(center, 1000); // D1 の IN 句へ
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
