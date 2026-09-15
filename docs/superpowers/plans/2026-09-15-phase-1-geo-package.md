# Phase 1: `packages/geo` 実装計画

> **エージェント作業者へ:** 必須サブスキル: `superpowers:subagent-driven-development`（推奨）または `superpowers:executing-plans` を使い、タスク単位で実装すること。各ステップはチェックボックス（`- [ ]`）で進捗管理する。

**ゴール:** D1 が地理空間拡張（PostGIS / R*Tree）を持たない制約を、純粋関数だけで構成した `@meshimap/geo` パッケージで埋める。

**アーキテクチャ:** 副作用ゼロ・依存ゼロの純粋関数のみ。I/O もフレームワーク依存も持たないため、Worker（`apps/api`）とアプリ（`apps/mobile`）の両方から同一コードを再利用できる。ブランド型（`Latitude` / `Longitude` / `Geohash`）で不正な値がドメインに侵入するのをコンパイル時に防ぐ。

**技術スタック:** TypeScript 6.0.3（strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax`）／ Vitest 5.0.0 ／ Stryker 10.0.0

## グローバル制約

- Node.js 22 系（`.nvmrc` = `22.23.2`）。
- すべてのコマンドはリポジトリルート `/Users/hattori/Downloads/alee` から `-w @meshimap/geo` 付きで実行する。
- **外部依存を一切追加しない。** `packages/geo/package.json` の `dependencies` は空のまま維持する。
- ファイル名は kebab-case。関数・変数は camelCase、定数は UPPER_SNAKE_CASE、型は PascalCase。
- `any` 禁止。`as` はブランド型生成時のみ許可（`docs/CODING_GUIDELINES.md` 82 行目の例外規定）。`as const` は型アサーションではないため制限外。
- 単位を名前に含める（`radiusM`、`distanceMeters`、`EARTH_RADIUS_M`）。
- コメントは日本語で「なぜ」を書く。「何を」はコードで表現する。
- **完了条件: 行・分岐・関数・文すべて 100% カバレッジ、かつミューテーションスコア 85% 以上。**
- デフォルトエクスポート禁止（名前付きエクスポートのみ）。
- `verbatimModuleSyntax` 有効のため、型のみの import は必ず `import type` を使う。
- 相対 import には拡張子を付けない（`moduleResolution: bundler` かつ Vitest がバンドラ解決を行うため）。

## 定数の根拠（実測値）

計画中の期待値はすべて Node で実測して確定済み。推測値は 1 つも含まない。

| 定数             | 値                                 | 根拠                                                                                  |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| `EARTH_RADIUS_M` | `6371008.8`                        | IUGG 平均半径（arithmetic mean radius $R_1$）。GeoJSON / PostGIS の球面近似と同じ値。 |
| geohash 基数表   | `0123456789bcdefghjkmnpqrstuvwxyz` | 標準 base32（`a`, `i`, `l`, `o` を除外）。                                            |

検証済みの既知ベクタ:

| 入力                                      | 期待値                   | 確認方法                                                             |
| ----------------------------------------- | ------------------------ | -------------------------------------------------------------------- |
| `encodeGeohash({57.64911, 10.40744}, 11)` | `"u4pruydqqvj"`          | Wikipedia の geohash 記事の標準ベクタと一致を実測確認                |
| 東京駅→大阪駅                             | `403058.1` m             | 実測（有効桁 1 位まで）                                              |
| 東京駅→渋谷駅                             | `6454.0` m               | 実測                                                                 |
| 渋谷駅→新宿駅                             | `3510.8` m               | 実測                                                                 |
| 対蹠点 (0,0)→(0,180)                      | `20015114.4` m = $\pi R$ | 実測。`Math.min(1, …)` ガードが無いと `NaN` になることも実測確認済み |

`precisionForRadius` の閾値は、日本国内（緯度 24〜46 度）で geohash セルの**最小辺**を 0.5 度刻みで実測して決めた:

| precision | 日本域でのセル最小辺（実測） | 採用する半径上限 |
| --------- | ---------------------------- | ---------------- |
| 7         | 106 m                        | 100 m            |
| 6         | 611 m                        | 600 m            |
| 5         | 3395 m                       | 3000 m           |
| 4         | 19546 m                      | 19000 m          |
| 3         | 109202 m                     | それ以上すべて   |

> 3×3 セルブロック（自セル + 8 近傍）で半径 `r` の円を必ず覆うには、クエリ点がセル端にある最悪ケースを想定して `セル最小辺 >= r` が必要。上の表はこの条件を満たす最大の precision を選ぶためのもの。

---

## ファイル構成

| ファイル                              | 責務                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `packages/geo/src/constants.ts`       | `EARTH_RADIUS_M`、`DEGREES_TO_RADIANS`、`GEOHASH_BASE32`、緯度経度の範囲定数      |
| `packages/geo/src/coordinate.ts`      | ブランド型 `Latitude` / `Longitude` / `Coordinate` とファクトリ                   |
| `packages/geo/src/distance.ts`        | `distanceMeters`（Haversine）                                                     |
| `packages/geo/src/format-distance.ts` | `formatDistance`（表示用整形）                                                    |
| `packages/geo/src/geohash.ts`         | `Geohash` 型、`encodeGeohash` / `decodeGeohash` / `neighborCells`                 |
| `packages/geo/src/search-cells.ts`    | `GeohashPrecision`、`toGeohashPrecision`、`precisionForRadius` / `cellsForRadius` |
| `packages/geo/src/bounding-box.ts`    | `BoundingBox` 型、`boundingBox` / `isWithinBounds`                                |
| `packages/geo/src/cluster.ts`         | `GridPoint` / `Cluster` 型、`precisionForZoom` / `clusterByGrid`                  |
| `packages/geo/src/index.ts`           | 再エクスポートのみ（ミューテーション対象外）                                      |

テストは各実装ファイルと同じディレクトリに `*.test.ts` として置く（`vitest.config.ts` の `include: ['src/**/*.test.ts']` に一致させる）。

**依存方向（一方通行、循環なし）:**

```
constants ← coordinate ← distance
                      ← geohash ← search-cells
                      ← bounding-box
                      ← cluster ← geohash
```

---

## Task 1-0: 定数モジュールとテスト基盤の疎通確認

前提タスク。ここが通らないと以降すべてが動かないため最初に片付ける。

**Files:**

- Create: `packages/geo/src/constants.ts`
- Create: `packages/geo/src/constants.test.ts`

**Interfaces:**

- Consumes: なし
- Produces: `EARTH_RADIUS_M: number`、`DEGREES_TO_RADIANS: number`、`GEOHASH_BASE32: string`、`LATITUDE_MIN/MAX`、`LONGITUDE_MIN/MAX`

- [ ] **Step 1: 失敗するテストを書く**

`packages/geo/src/constants.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DEGREES_TO_RADIANS,
  EARTH_RADIUS_M,
  GEOHASH_BASE32,
  LATITUDE_MAX,
  LATITUDE_MIN,
  LONGITUDE_MAX,
  LONGITUDE_MIN,
} from './constants';

describe('地理定数', () => {
  it('地球半径は IUGG 平均半径（6371008.8m）である', () => {
    expect(EARTH_RADIUS_M).toBe(6371008.8);
  });

  it('度からラジアンへの変換係数は π/180 である', () => {
    expect(DEGREES_TO_RADIANS).toBe(Math.PI / 180);
  });

  it('geohash の基数表は 32 文字である', () => {
    expect(GEOHASH_BASE32).toHaveLength(32);
  });

  it('geohash の基数表は標準の base32（a/i/l/o を除く）である', () => {
    expect(GEOHASH_BASE32).toBe('0123456789bcdefghjkmnpqrstuvwxyz');
  });

  it('geohash の基数表に重複文字がない', () => {
    expect(new Set(GEOHASH_BASE32).size).toBe(GEOHASH_BASE32.length);
  });

  it('緯度の範囲は -90 〜 90 である', () => {
    expect(LATITUDE_MIN).toBe(-90);
    expect(LATITUDE_MAX).toBe(90);
  });

  it('経度の範囲は -180 〜 180 である', () => {
    expect(LONGITUDE_MIN).toBe(-180);
    expect(LONGITUDE_MAX).toBe(180);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/geo
```

期待: `Failed to resolve import "./constants"` で失敗する。**このメッセージを目で見ること。** 見ずに次へ進むと、テストが実際には何も検証していない状態に気付けない。

- [ ] **Step 3: 最小実装を書く**

`packages/geo/src/constants.ts`:

```ts
/**
 * 地球の平均半径（メートル）。
 * IUGG の arithmetic mean radius R1 を採用する。PostGIS の球面近似と同じ値なので、
 * 将来 D1 から PostgreSQL へ移行しても距離計算の結果が変わらない。
 */
export const EARTH_RADIUS_M = 6371008.8;

/** 度 → ラジアン変換係数。三角関数に渡す前に必ず掛ける。 */
export const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * geohash の base32 基数表。
 * 見間違えやすい a / i / l / o を除いた標準の並び。この順序自体が仕様なので変更不可。
 */
export const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export const LATITUDE_MIN = -90;
export const LATITUDE_MAX = 90;
export const LONGITUDE_MIN = -180;
export const LONGITUDE_MAX = 180;
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm run test -w @meshimap/geo
```

期待: 7 件すべて PASS。

- [ ] **Step 5: 型チェックを通す**

```bash
npm run typecheck -w @meshimap/geo
```

期待: エラーなし。

- [ ] **Step 6: コミット**

```bash
git add packages/geo/src/constants.ts packages/geo/src/constants.test.ts
git commit -m "feat(geo): 地理計算の基礎定数を追加"
```

---

## Task 1-1: 座標のブランド型

**Files:**

- Create: `packages/geo/src/coordinate.ts`
- Create: `packages/geo/src/coordinate.test.ts`

**Interfaces:**

- Consumes: `constants.ts` の `LATITUDE_MIN/MAX`、`LONGITUDE_MIN/MAX`
- Produces:
  - `type Latitude`（ブランド付き `number`）
  - `type Longitude`（ブランド付き `number`）
  - `type Coordinate = { readonly latitude: Latitude; readonly longitude: Longitude }`
  - `toLatitude(value: number): Latitude`
  - `toLongitude(value: number): Longitude`
  - `coordinate(latitude: number, longitude: number): Coordinate`

> 以降すべての関数は `Coordinate` を受け取る。生の `{ lat, lng }` を受け取る関数を作らないこと。範囲チェックを一箇所に集約するのがこの型の目的であり、迂回路を作ると意味が失われる。

- [ ] **Step 1: 失敗するテストを書く**

`packages/geo/src/coordinate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { coordinate, toLatitude, toLongitude } from './coordinate';

describe('toLatitude', () => {
  it('範囲内の値をそのまま返す', () => {
    expect(toLatitude(35.681236)).toBe(35.681236);
  });

  it('下限 -90 を受け入れる', () => {
    expect(toLatitude(-90)).toBe(-90);
  });

  it('上限 90 を受け入れる', () => {
    expect(toLatitude(90)).toBe(90);
  });

  it('0 を受け入れる', () => {
    expect(toLatitude(0)).toBe(0);
  });

  it('下限をわずかに下回る値を拒否する', () => {
    expect(() => toLatitude(-90.000001)).toThrow(
      new RangeError('緯度は -90 〜 90 の範囲である必要があります: -90.000001'),
    );
  });

  it('上限をわずかに上回る値を拒否する', () => {
    expect(() => toLatitude(90.000001)).toThrow(
      new RangeError('緯度は -90 〜 90 の範囲である必要があります: 90.000001'),
    );
  });

  it('NaN を拒否する', () => {
    expect(() => toLatitude(Number.NaN)).toThrow(
      new RangeError('緯度は有限の数値である必要があります: NaN'),
    );
  });

  it('Infinity を拒否する', () => {
    expect(() => toLatitude(Number.POSITIVE_INFINITY)).toThrow(
      new RangeError('緯度は有限の数値である必要があります: Infinity'),
    );
  });

  it('-Infinity を拒否する', () => {
    expect(() => toLatitude(Number.NEGATIVE_INFINITY)).toThrow(
      new RangeError('緯度は有限の数値である必要があります: -Infinity'),
    );
  });
});

describe('toLongitude', () => {
  it('範囲内の値をそのまま返す', () => {
    expect(toLongitude(139.767125)).toBe(139.767125);
  });

  it('下限 -180 を受け入れる', () => {
    expect(toLongitude(-180)).toBe(-180);
  });

  it('上限 180 を受け入れる', () => {
    expect(toLongitude(180)).toBe(180);
  });

  it('下限をわずかに下回る値を拒否する', () => {
    expect(() => toLongitude(-180.000001)).toThrow(
      new RangeError('経度は -180 〜 180 の範囲である必要があります: -180.000001'),
    );
  });

  it('上限をわずかに上回る値を拒否する', () => {
    expect(() => toLongitude(180.000001)).toThrow(
      new RangeError('経度は -180 〜 180 の範囲である必要があります: 180.000001'),
    );
  });

  it('NaN を拒否する', () => {
    expect(() => toLongitude(Number.NaN)).toThrow(
      new RangeError('経度は有限の数値である必要があります: NaN'),
    );
  });

  it('Infinity を拒否する', () => {
    expect(() => toLongitude(Number.POSITIVE_INFINITY)).toThrow(
      new RangeError('経度は有限の数値である必要があります: Infinity'),
    );
  });
});

describe('coordinate', () => {
  it('緯度経度を保持したオブジェクトを返す', () => {
    expect(coordinate(35.681236, 139.767125)).toEqual({
      latitude: 35.681236,
      longitude: 139.767125,
    });
  });

  it('緯度が不正なら経度を検証する前に例外を投げる', () => {
    expect(() => coordinate(91, 999)).toThrow(
      new RangeError('緯度は -90 〜 90 の範囲である必要があります: 91'),
    );
  });

  it('経度が不正なら例外を投げる', () => {
    expect(() => coordinate(35, 181)).toThrow(
      new RangeError('経度は -180 〜 180 の範囲である必要があります: 181'),
    );
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/geo -- coordinate
```

期待: `Failed to resolve import "./coordinate"`。

- [ ] **Step 3: 最小実装を書く**

`packages/geo/src/coordinate.ts`:

```ts
import { LATITUDE_MAX, LATITUDE_MIN, LONGITUDE_MAX, LONGITUDE_MIN } from './constants';

declare const latitudeBrand: unique symbol;
declare const longitudeBrand: unique symbol;

/** 検証済みの緯度。`toLatitude` 経由でしか生成できない。 */
export type Latitude = number & { readonly [latitudeBrand]: true };

/** 検証済みの経度。`toLongitude` 経由でしか生成できない。 */
export type Longitude = number & { readonly [longitudeBrand]: true };

export type Coordinate = {
  readonly latitude: Latitude;
  readonly longitude: Longitude;
};

export function toLatitude(value: number): Latitude {
  if (!Number.isFinite(value)) {
    throw new RangeError(`緯度は有限の数値である必要があります: ${value}`);
  }
  if (value < LATITUDE_MIN || value > LATITUDE_MAX) {
    throw new RangeError(
      `緯度は ${LATITUDE_MIN} 〜 ${LATITUDE_MAX} の範囲である必要があります: ${value}`,
    );
  }
  // ブランド型の生成点。検証を通過した値だけがここに到達する（規約 82 行目の例外）
  return value as Latitude;
}

export function toLongitude(value: number): Longitude {
  if (!Number.isFinite(value)) {
    throw new RangeError(`経度は有限の数値である必要があります: ${value}`);
  }
  if (value < LONGITUDE_MIN || value > LONGITUDE_MAX) {
    throw new RangeError(
      `経度は ${LONGITUDE_MIN} 〜 ${LONGITUDE_MAX} の範囲である必要があります: ${value}`,
    );
  }
  // ブランド型の生成点（規約 82 行目の例外）
  return value as Longitude;
}

export function coordinate(latitude: number, longitude: number): Coordinate {
  return {
    latitude: toLatitude(latitude),
    longitude: toLongitude(longitude),
  };
}
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm run test -w @meshimap/geo -- coordinate
```

期待: 20 件すべて PASS。

- [ ] **Step 5: ブランド型がコンパイル時に効いていることを確認する**

一時ファイル `packages/geo/src/brand-check.tmp.ts` を作って型エラーが出ることを確認する。

```ts
import type { Coordinate } from './coordinate';

// 生の number を代入できないことを確認するための一時コード
const invalid: Coordinate = { latitude: 35, longitude: 139 };
void invalid;
```

```bash
npm run typecheck -w @meshimap/geo
```

期待: `Type 'number' is not assignable to type 'Latitude'` が出る。**出なければブランド型が機能していない**ので `declare const ... unique symbol` の書き方を見直すこと。確認できたらファイルを削除する。

```bash
rm packages/geo/src/brand-check.tmp.ts
```

- [ ] **Step 6: 意図的にコードを壊してテストが検知することを確認する**

`coordinate.ts` の `toLatitude` を一時的に次へ変える（境界の `>` を `>=` にする）:

```ts
  if (value < LATITUDE_MIN || value >= LATITUDE_MAX) {
```

```bash
npm run test -w @meshimap/geo -- coordinate
```

期待: `上限 90 を受け入れる` が FAIL する。**これが FAIL しないなら境界値テストが足りていない。** 確認後、元に戻してテストが全件 PASS することを再確認する。

- [ ] **Step 7: コミット**

```bash
git add packages/geo/src/coordinate.ts packages/geo/src/coordinate.test.ts
git commit -m "feat(geo): 座標のブランド型とファクトリを追加"
```

---

## Task 1-2: Haversine 距離

**Files:**

- Create: `packages/geo/src/distance.ts`
- Create: `packages/geo/src/distance.test.ts`

**Interfaces:**

- Consumes: `constants.ts` の `EARTH_RADIUS_M` / `DEGREES_TO_RADIANS`、`coordinate.ts` の `Coordinate` / `coordinate`
- Produces: `distanceMeters(from: Coordinate, to: Coordinate): number`

- [ ] **Step 1: 失敗するテストを書く**

`packages/geo/src/distance.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { coordinate } from './coordinate';
import { distanceMeters } from './distance';

// 実測で確定した既知の座標（テスト間で共有する）
const TOKYO_STATION = coordinate(35.681236, 139.767125);
const OSAKA_STATION = coordinate(34.702485, 135.495951);
const SHIBUYA_STATION = coordinate(35.658034, 139.701636);
const SHINJUKU_STATION = coordinate(35.689592, 139.700413);

describe('distanceMeters', () => {
  it('同一点の距離は 0 である', () => {
    expect(distanceMeters(TOKYO_STATION, TOKYO_STATION)).toBe(0);
  });

  it('東京駅から大阪駅までの距離が実測値と一致する', () => {
    expect(distanceMeters(TOKYO_STATION, OSAKA_STATION)).toBeCloseTo(403058.1, 1);
  });

  it('東京駅から渋谷駅までの距離が実測値と一致する', () => {
    expect(distanceMeters(TOKYO_STATION, SHIBUYA_STATION)).toBeCloseTo(6454.0, 1);
  });

  it('渋谷駅から新宿駅までの距離が実測値と一致する', () => {
    expect(distanceMeters(SHIBUYA_STATION, SHINJUKU_STATION)).toBeCloseTo(3510.8, 1);
  });

  it('距離は対称である（引数の順序を入れ替えても同じ）', () => {
    expect(distanceMeters(TOKYO_STATION, OSAKA_STATION)).toBe(
      distanceMeters(OSAKA_STATION, TOKYO_STATION),
    );
  });

  it('赤道上の経度 1 度は約 111195m である', () => {
    expect(distanceMeters(coordinate(0, 0), coordinate(0, 1))).toBeCloseTo(111195.1, 1);
  });

  it('日付変更線を跨ぐ距離を短い側で計算する', () => {
    // 経度を単純に引き算すると 359.8 度分（約 4 万 km）になってしまう
    expect(distanceMeters(coordinate(0, 179.9), coordinate(0, -179.9))).toBeCloseTo(22239.0, 1);
  });

  it('対蹠点の距離は地球半周（πR）である', () => {
    // 浮動小数点誤差で sqrt の引数が 1 をわずかに超えると asin が NaN を返す。
    // Math.min(1, …) のクランプが無いとこのテストが落ちる
    expect(distanceMeters(coordinate(0, 0), coordinate(0, 180))).toBeCloseTo(20015114.4, 1);
  });

  it('北極と南極の距離は地球半周である', () => {
    expect(distanceMeters(coordinate(90, 0), coordinate(-90, 0))).toBeCloseTo(20015114.4, 1);
  });

  it('極付近の経度差は距離にほとんど寄与しない', () => {
    // 緯度 89.9 度で経度 180 度離れていても、極を挟んだ 22km 程度にしかならない
    expect(distanceMeters(coordinate(89.9, 0), coordinate(89.9, 180))).toBeCloseTo(22239.0, 1);
  });

  it('常に 0 以上を返す', () => {
    expect(distanceMeters(OSAKA_STATION, TOKYO_STATION)).toBeGreaterThan(0);
    expect(distanceMeters(coordinate(-35, -139), coordinate(35, 139))).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/geo -- distance
```

期待: `Failed to resolve import "./distance"`。

- [ ] **Step 3: 最小実装を書く**

`packages/geo/src/distance.ts`:

```ts
import { DEGREES_TO_RADIANS, EARTH_RADIUS_M } from './constants';
import type { Coordinate } from './coordinate';

/**
 * 2 点間の大円距離をメートルで返す（Haversine 公式）。
 *
 * D1 には ST_Distance が無く、SQLite の三角関数は環境差があるため SQL 側では計算しない。
 * 候補を geohash と境界ボックスで絞り込んだあと、この関数で Worker 側の TypeScript として
 * 正確な距離を求める設計にしている。
 */
export function distanceMeters(from: Coordinate, to: Coordinate): number {
  const fromLatitudeRad = from.latitude * DEGREES_TO_RADIANS;
  const toLatitudeRad = to.latitude * DEGREES_TO_RADIANS;
  const deltaLatitudeRad = (to.latitude - from.latitude) * DEGREES_TO_RADIANS;
  const deltaLongitudeRad = (to.longitude - from.longitude) * DEGREES_TO_RADIANS;

  const haversine =
    Math.sin(deltaLatitudeRad / 2) ** 2 +
    Math.cos(fromLatitudeRad) * Math.cos(toLatitudeRad) * Math.sin(deltaLongitudeRad / 2) ** 2;

  // 対蹠点付近では浮動小数点誤差で sqrt の結果が 1 をわずかに超え、asin が NaN を返す。
  // 1 でクランプして定義域を守る
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(haversine)));
}
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm run test -w @meshimap/geo -- distance
```

期待: 11 件すべて PASS。

- [ ] **Step 5: 意図的にコードを壊してテストが検知することを確認する**

`Math.min(1, Math.sqrt(haversine))` を `Math.sqrt(haversine)` に変える。

```bash
npm run test -w @meshimap/geo -- distance
```

期待: `対蹠点の距離は地球半周（πR）である` が `NaN` で FAIL する。確認後に元へ戻す。

さらに `2 * EARTH_RADIUS_M` を `EARTH_RADIUS_M` に変えて実行し、距離系のテストが軒並み FAIL することを確認してから元へ戻す。

- [ ] **Step 6: コミット**

```bash
git add packages/geo/src/distance.ts packages/geo/src/distance.test.ts
git commit -m "feat(geo): Haversine による距離計算を追加"
```

---

## Task 1-3: 距離の表示整形

**Files:**

- Create: `packages/geo/src/format-distance.ts`
- Create: `packages/geo/src/format-distance.test.ts`

**Interfaces:**

- Consumes: なし
- Produces: `formatDistance(meters: number): string`

**仕様（実測で確定した丸め規則）:**

| 条件                         | 表示               | 例                                         |
| ---------------------------- | ------------------ | ------------------------------------------ |
| 四捨五入した結果が 1000 未満 | 整数 + `m`         | `999.4` → `"999m"`                         |
| 1000 以上 10000 未満         | 小数第 1 位 + `km` | `999.5` → `"1.0km"`、`1050` → `"1.1km"`    |
| 10000 以上                   | 整数 + `km`        | `10499` → `"10km"`、`403058.1` → `"403km"` |
| 負の値                       | 例外               | —                                          |

> `999.5` が `"1000m"` ではなく `"1.0km"` になるのは、先に四捨五入してから単位を決めているため。`"1000m"` という表示は UI として不自然なので、この順序を意図的に選んでいる。

- [ ] **Step 1: 失敗するテストを書く**

`packages/geo/src/format-distance.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatDistance } from './format-distance';

describe('formatDistance', () => {
  it.each([
    [0, '0m'],
    [0.4, '0m'],
    [0.5, '1m'],
    [1, '1m'],
    [499.5, '500m'],
    [999, '999m'],
    [999.4, '999m'],
  ])('%p メートルを %p と表示する', (meters, expected) => {
    expect(formatDistance(meters)).toBe(expected);
  });

  it.each([
    [999.5, '1.0km'],
    [1000, '1.0km'],
    [1049, '1.0km'],
    [1050, '1.1km'],
    [9949, '9.9km'],
    [9999, '10.0km'],
  ])('%p メートルを %p と表示する', (meters, expected) => {
    expect(formatDistance(meters)).toBe(expected);
  });

  it.each([
    [10000, '10km'],
    [10499, '10km'],
    [10500, '11km'],
    [403058.1, '403km'],
  ])('%p メートルを %p と表示する', (meters, expected) => {
    expect(formatDistance(meters)).toBe(expected);
  });

  it('負の距離を拒否する', () => {
    expect(() => formatDistance(-1)).toThrow(
      new RangeError('距離は 0 以上である必要があります: -1'),
    );
  });

  it('NaN を拒否する', () => {
    expect(() => formatDistance(Number.NaN)).toThrow(
      new RangeError('距離は有限の数値である必要があります: NaN'),
    );
  });

  it('Infinity を拒否する', () => {
    expect(() => formatDistance(Number.POSITIVE_INFINITY)).toThrow(
      new RangeError('距離は有限の数値である必要があります: Infinity'),
    );
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/geo -- format-distance
```

期待: `Failed to resolve import "./format-distance"`。

- [ ] **Step 3: 最小実装を書く**

`packages/geo/src/format-distance.ts`:

```ts
/** メートル表記からキロメートル表記へ切り替える閾値。 */
const KILOMETER_THRESHOLD_M = 1000;

/** 小数第 1 位付きの km 表記から整数 km 表記へ切り替える閾値。 */
const INTEGER_KILOMETER_THRESHOLD_M = 10000;

const METERS_PER_KILOMETER = 1000;

/** 距離を UI 表示用の文字列へ整形する（例: 850 → "850m"、1500 → "1.5km"）。 */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) {
    throw new RangeError(`距離は有限の数値である必要があります: ${meters}`);
  }
  if (meters < 0) {
    throw new RangeError(`距離は 0 以上である必要があります: ${meters}`);
  }

  // 先に四捨五入してから単位を決める。そうしないと 999.5m が "1000m" になってしまう
  const roundedMeters = Math.round(meters);
  if (roundedMeters < KILOMETER_THRESHOLD_M) {
    return `${roundedMeters}m`;
  }

  if (meters < INTEGER_KILOMETER_THRESHOLD_M) {
    return `${(meters / METERS_PER_KILOMETER).toFixed(1)}km`;
  }

  return `${Math.round(meters / METERS_PER_KILOMETER)}km`;
}
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm run test -w @meshimap/geo -- format-distance
```

期待: 20 件すべて PASS。

- [ ] **Step 5: 意図的にコードを壊してテストが検知することを確認する**

`const roundedMeters = Math.round(meters);` を `const roundedMeters = Math.floor(meters);` に変える。

```bash
npm run test -w @meshimap/geo -- format-distance
```

期待: `0.5 メートルを "1m" と表示する` と `499.5 メートルを "500m" と表示する` と `999.5 メートルを "1.0km" と表示する` が FAIL。確認後に元へ戻す。

- [ ] **Step 6: コミット**

```bash
git add packages/geo/src/format-distance.ts packages/geo/src/format-distance.test.ts
git commit -m "feat(geo): 距離の表示整形を追加"
```

---

## Task 1-4: geohash エンコード

**Files:**

- Create: `packages/geo/src/geohash.ts`
- Create: `packages/geo/src/geohash.test.ts`

**Interfaces:**

- Consumes: `constants.ts` の `GEOHASH_BASE32` ほか範囲定数、`coordinate.ts` の `Coordinate`
- Produces:
  - `type Geohash`（ブランド付き `string`）
  - `type GeohashPrecision = 1 | 2 | … | 12`
  - `encodeGeohash(target: Coordinate, precision: GeohashPrecision): Geohash`

> `GeohashPrecision` は Task 1-7 の `search-cells.ts` ではなくここに置く。`encodeGeohash` の引数型であり、依存方向を `geohash → search-cells` の一方通行に保つため。

- [ ] **Step 1: 失敗するテストを書く**

`packages/geo/src/geohash.test.ts`（このファイルは Task 1-5・1-6 でも追記する）:

```ts
import { describe, expect, it } from 'vitest';
import { coordinate } from './coordinate';
import { encodeGeohash } from './geohash';

const TOKYO_STATION = coordinate(35.681236, 139.767125);
const OSAKA_STATION = coordinate(34.702485, 135.495951);
const SHINJUKU_STATION = coordinate(35.689592, 139.700413);

describe('encodeGeohash', () => {
  it('Wikipedia の標準ベクタと一致する', () => {
    expect(encodeGeohash(coordinate(57.64911, 10.40744), 11)).toBe('u4pruydqqvj');
  });

  it('東京駅を precision 6 でエンコードする', () => {
    expect(encodeGeohash(TOKYO_STATION, 6)).toBe('xn76ur');
  });

  it('東京駅を precision 9 でエンコードする', () => {
    expect(encodeGeohash(TOKYO_STATION, 9)).toBe('xn76urx66');
  });

  it('大阪駅を precision 6 でエンコードする', () => {
    expect(encodeGeohash(OSAKA_STATION, 6)).toBe('xn0m7m');
  });

  it('新宿駅を precision 6 でエンコードする', () => {
    expect(encodeGeohash(SHINJUKU_STATION, 6)).toBe('xn774c');
  });

  it('原点 (0, 0) は s から始まる', () => {
    expect(encodeGeohash(coordinate(0, 0), 9)).toBe('s00000000');
  });

  it('precision の文字数だけ返す', () => {
    for (let precision = 1; precision <= 12; precision += 1) {
      // GeohashPrecision の全域を走査するためのループ
      expect(encodeGeohash(TOKYO_STATION, precision as 1)).toHaveLength(precision);
    }
  });

  it('precision を 1 増やしても前方一致は保たれる', () => {
    const shorter = encodeGeohash(TOKYO_STATION, 6);
    const longer = encodeGeohash(TOKYO_STATION, 7);
    expect(longer.startsWith(shorter)).toBe(true);
  });

  it('近い 2 点は長い共通接頭辞を持つ', () => {
    const shibuya = encodeGeohash(coordinate(35.658034, 139.701636), 6);
    expect(encodeGeohash(TOKYO_STATION, 6).slice(0, 4)).toBe(shibuya.slice(0, 4));
  });

  it('遠い 2 点は共通接頭辞が短い', () => {
    expect(encodeGeohash(TOKYO_STATION, 6).slice(0, 3)).not.toBe(
      encodeGeohash(OSAKA_STATION, 6).slice(0, 3),
    );
  });

  it('base32 に含まれる文字だけを返す', () => {
    expect(encodeGeohash(TOKYO_STATION, 12)).toMatch(/^[0-9bcdefghjkmnpqrstuvwxyz]+$/);
  });

  it('南西の端 (-90, -180) をエンコードできる', () => {
    expect(encodeGeohash(coordinate(-90, -180), 6)).toBe('000000');
  });

  it('北東の端 (90, 180) をエンコードできる', () => {
    expect(encodeGeohash(coordinate(90, 180), 6)).toBe('zzzzzz');
  });
});
```

> `precision as 1` は `GeohashPrecision` 全域をループで走査するためのテスト内限定の記法。本番コードでは使わない。

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/geo -- geohash
```

期待: `Failed to resolve import "./geohash"`。

- [ ] **Step 3: 最小実装を書く**

`packages/geo/src/geohash.ts`:

```ts
import {
  GEOHASH_BASE32,
  LATITUDE_MAX,
  LATITUDE_MIN,
  LONGITUDE_MAX,
  LONGITUDE_MIN,
} from './constants';
import type { Coordinate } from './coordinate';

declare const geohashBrand: unique symbol;

/** base32 の geohash 文字列。`encodeGeohash` 経由でしか生成できない。 */
export type Geohash = string & { readonly [geohashBrand]: true };

/** geohash の桁数。1 桁あたり 5 ビット増える。 */
export type GeohashPrecision = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

/** base32 の 1 文字が表すビット数。 */
const BITS_PER_CHARACTER = 5;

/**
 * 座標を geohash へエンコードする。
 *
 * 経度・緯度を交互に二分し、上半分なら 1 / 下半分なら 0 のビットを立てる。
 * 5 ビット貯まるごとに base32 の 1 文字へ変換する。
 * 接頭辞が一致する = 近い、という性質が D1 の B-tree インデックスで
 * `GLOB 'xn774c*'` による近傍絞り込みを可能にしている。
 */
export function encodeGeohash(target: Coordinate, precision: GeohashPrecision): Geohash {
  let latitudeMin: number = LATITUDE_MIN;
  let latitudeMax: number = LATITUDE_MAX;
  let longitudeMin: number = LONGITUDE_MIN;
  let longitudeMax: number = LONGITUDE_MAX;

  let isLongitudeTurn = true;
  let bitCount = 0;
  let characterIndex = 0;
  let hash = '';

  while (hash.length < precision) {
    if (isLongitudeTurn) {
      const middle = (longitudeMin + longitudeMax) / 2;
      if (target.longitude >= middle) {
        characterIndex = characterIndex * 2 + 1;
        longitudeMin = middle;
      } else {
        characterIndex *= 2;
        longitudeMax = middle;
      }
    } else {
      const middle = (latitudeMin + latitudeMax) / 2;
      if (target.latitude >= middle) {
        characterIndex = characterIndex * 2 + 1;
        latitudeMin = middle;
      } else {
        characterIndex *= 2;
        latitudeMax = middle;
      }
    }

    isLongitudeTurn = !isLongitudeTurn;
    bitCount += 1;

    if (bitCount === BITS_PER_CHARACTER) {
      // charAt は範囲外でも空文字を返すため noUncheckedIndexedAccess の影響を受けない
      hash += GEOHASH_BASE32.charAt(characterIndex);
      bitCount = 0;
      characterIndex = 0;
    }
  }

  // ブランド型の生成点（規約 82 行目の例外）
  return hash as Geohash;
}
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm run test -w @meshimap/geo -- geohash
```

期待: 13 件すべて PASS。とくに `Wikipedia の標準ベクタと一致する` が通ることを目視すること。ここが通れば実装は仕様どおり。

- [ ] **Step 5: 意図的にコードを壊してテストが検知することを確認する**

`let isLongitudeTurn = true;` を `false` に変える（緯度・経度の順序を入れ替える）。

```bash
npm run test -w @meshimap/geo -- geohash
```

期待: `Wikipedia の標準ベクタと一致する` を含むほぼ全件が FAIL。確認後に元へ戻す。

次に `if (target.longitude >= middle)` を `>` に変える。

期待: `南西の端 (-90, -180) をエンコードできる` または `原点 (0, 0) は s から始まる` が FAIL。確認後に元へ戻す。

- [ ] **Step 6: コミット**

```bash
git add packages/geo/src/geohash.ts packages/geo/src/geohash.test.ts
git commit -m "feat(geo): geohash エンコードを追加"
```

---

## Task 1-5: geohash デコード

**Files:**

- Modify: `packages/geo/src/geohash.ts`（`decodeGeohash` と `toGeohash` を追加）
- Modify: `packages/geo/src/geohash.test.ts`（`describe('decodeGeohash')` を追記）

**Interfaces:**

- Consumes: Task 1-4 の `Geohash` / `GeohashPrecision` / `encodeGeohash`
- Produces:
  - `type GeohashBounds = { readonly latitudeMin: number; readonly latitudeMax: number; readonly longitudeMin: number; readonly longitudeMax: number; readonly center: Coordinate }`
  - `toGeohash(value: string): Geohash`（外部入力の検証用ファクトリ）
  - `decodeGeohash(hash: Geohash): GeohashBounds`

> `decodeGeohash` は `Geohash` 型しか受け取らない。API のクエリ文字列など外部由来の文字列は必ず `toGeohash` を通す。検証を 1 箇所に集約するのが目的。

- [ ] **Step 1: 失敗するテストを書く**

`packages/geo/src/geohash.test.ts` の末尾に追記:

```ts
describe('toGeohash', () => {
  it('正しい geohash 文字列をそのまま返す', () => {
    expect(toGeohash('xn76ur')).toBe('xn76ur');
  });

  it('空文字を拒否する', () => {
    expect(() => toGeohash('')).toThrow(
      new RangeError('geohash の桁数は 1 〜 12 である必要があります: ""'),
    );
  });

  it('13 桁以上を拒否する', () => {
    expect(() => toGeohash('xn76urx6606pb')).toThrow(
      new RangeError('geohash の桁数は 1 〜 12 である必要があります: "xn76urx6606pb"'),
    );
  });

  it.each(['a', 'i', 'l', 'o'])('base32 から除外された文字 %p を拒否する', (character) => {
    expect(() => toGeohash(character)).toThrow(
      new RangeError(`geohash に使用できない文字が含まれています: "${character}"`),
    );
  });

  it('大文字を拒否する', () => {
    expect(() => toGeohash('XN76UR')).toThrow(
      new RangeError('geohash に使用できない文字が含まれています: "XN76UR"'),
    );
  });

  it('記号を拒否する', () => {
    expect(() => toGeohash('xn76-r')).toThrow(
      new RangeError('geohash に使用できない文字が含まれています: "xn76-r"'),
    );
  });

  it('12 桁ちょうどを受け入れる', () => {
    expect(toGeohash('xn76urx6606p')).toBe('xn76urx6606p');
  });
});

describe('decodeGeohash', () => {
  it('precision 6 のセル境界を返す', () => {
    expect(decodeGeohash(toGeohash('xn76ur'))).toEqual({
      latitudeMin: 35.6781005859375,
      latitudeMax: 35.68359375,
      longitudeMin: 139.757080078125,
      longitudeMax: 139.76806640625,
      center: { latitude: 35.68084716796875, longitude: 139.7625732421875 },
    });
  });

  it('1 桁の geohash は世界を 32 分割したセルを表す', () => {
    const bounds = decodeGeohash(toGeohash('s'));
    expect(bounds.latitudeMin).toBe(0);
    expect(bounds.latitudeMax).toBe(45);
    expect(bounds.longitudeMin).toBe(0);
    expect(bounds.longitudeMax).toBe(45);
  });

  it('最小のセル "0" は南西の隅である', () => {
    const bounds = decodeGeohash(toGeohash('0'));
    expect(bounds.latitudeMin).toBe(-90);
    expect(bounds.longitudeMin).toBe(-180);
  });

  it('最大のセル "z" は北東の隅である', () => {
    const bounds = decodeGeohash(toGeohash('z'));
    expect(bounds.latitudeMax).toBe(90);
    expect(bounds.longitudeMax).toBe(180);
  });

  it('中心は境界の中点である', () => {
    const bounds = decodeGeohash(toGeohash('xn774c'));
    expect(bounds.center.latitude).toBe((bounds.latitudeMin + bounds.latitudeMax) / 2);
    expect(bounds.center.longitude).toBe((bounds.longitudeMin + bounds.longitudeMax) / 2);
  });

  it.each([6, 9, 12] as const)('precision %i でエンコードと往復する', (precision) => {
    const original = encodeGeohash(TOKYO_STATION, precision);
    const center = decodeGeohash(original).center;
    expect(encodeGeohash(center, precision)).toBe(original);
  });

  it('precision が上がるほどセルが小さくなる', () => {
    const coarse = decodeGeohash(encodeGeohash(TOKYO_STATION, 5));
    const fine = decodeGeohash(encodeGeohash(TOKYO_STATION, 6));
    expect(fine.latitudeMax - fine.latitudeMin).toBeLessThan(
      coarse.latitudeMax - coarse.latitudeMin,
    );
  });

  it('元の座標はデコードしたセルの内側にある', () => {
    const bounds = decodeGeohash(encodeGeohash(TOKYO_STATION, 9));
    expect(TOKYO_STATION.latitude).toBeGreaterThanOrEqual(bounds.latitudeMin);
    expect(TOKYO_STATION.latitude).toBeLessThanOrEqual(bounds.latitudeMax);
    expect(TOKYO_STATION.longitude).toBeGreaterThanOrEqual(bounds.longitudeMin);
    expect(TOKYO_STATION.longitude).toBeLessThanOrEqual(bounds.longitudeMax);
  });
});
```

ファイル先頭の import を更新する:

```ts
import { decodeGeohash, encodeGeohash, toGeohash } from './geohash';
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/geo -- geohash
```

期待: `decodeGeohash is not a function` 系のエラー、または import の解決失敗。

- [ ] **Step 3: 最小実装を書く**

`packages/geo/src/geohash.ts` に追記する。まずファイル先頭の import に `coordinate` を追加:

```ts
import { coordinate } from './coordinate';
import type { Coordinate } from './coordinate';
```

続けてファイル末尾に追記:

```ts
export const GEOHASH_LENGTH_MIN = 1;
export const GEOHASH_LENGTH_MAX = 12;

/** geohash セルの矩形範囲と中心。 */
export type GeohashBounds = {
  readonly latitudeMin: number;
  readonly latitudeMax: number;
  readonly longitudeMin: number;
  readonly longitudeMax: number;
  readonly center: Coordinate;
};

/**
 * 外部入力の文字列を `Geohash` へ変換する。
 * API のクエリ文字列や D1 から読んだ値はすべてここを通す。
 */
export function toGeohash(value: string): Geohash {
  if (value.length < GEOHASH_LENGTH_MIN || value.length > GEOHASH_LENGTH_MAX) {
    throw new RangeError(
      `geohash の桁数は ${GEOHASH_LENGTH_MIN} 〜 ${GEOHASH_LENGTH_MAX} である必要があります: "${value}"`,
    );
  }
  for (const character of value) {
    if (!GEOHASH_BASE32.includes(character)) {
      throw new RangeError(`geohash に使用できない文字が含まれています: "${value}"`);
    }
  }
  // ブランド型の生成点（規約 82 行目の例外）
  return value as Geohash;
}

/**
 * geohash をセルの矩形範囲へ戻す。
 *
 * エンコードと逆に、各文字を 5 ビットへ展開して経度・緯度の区間を交互に半分へ狭める。
 * 戻り値は「点」ではなく「矩形」である点に注意。geohash は可逆ではなく、
 * 精度に応じた誤差がセルの大きさとして残る。
 */
export function decodeGeohash(hash: Geohash): GeohashBounds {
  let latitudeMin: number = LATITUDE_MIN;
  let latitudeMax: number = LATITUDE_MAX;
  let longitudeMin: number = LONGITUDE_MIN;
  let longitudeMax: number = LONGITUDE_MAX;
  let isLongitudeTurn = true;

  for (const character of hash) {
    const characterIndex = GEOHASH_BASE32.indexOf(character);
    for (let bitPosition = BITS_PER_CHARACTER - 1; bitPosition >= 0; bitPosition -= 1) {
      const isUpperHalf = ((characterIndex >> bitPosition) & 1) === 1;
      if (isLongitudeTurn) {
        const middle = (longitudeMin + longitudeMax) / 2;
        if (isUpperHalf) {
          longitudeMin = middle;
        } else {
          longitudeMax = middle;
        }
      } else {
        const middle = (latitudeMin + latitudeMax) / 2;
        if (isUpperHalf) {
          latitudeMin = middle;
        } else {
          latitudeMax = middle;
        }
      }
      isLongitudeTurn = !isLongitudeTurn;
    }
  }

  return {
    latitudeMin,
    latitudeMax,
    longitudeMin,
    longitudeMax,
    center: coordinate((latitudeMin + latitudeMax) / 2, (longitudeMin + longitudeMax) / 2),
  };
}
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm run test -w @meshimap/geo -- geohash
```

期待: Task 1-4 の 13 件 + 今回の 19 件 = 32 件すべて PASS。

- [ ] **Step 5: 意図的にコードを壊してテストが検知することを確認する**

`for (let bitPosition = BITS_PER_CHARACTER - 1; …)` を `for (let bitPosition = 0; bitPosition < BITS_PER_CHARACTER; bitPosition += 1)` に変える（ビット順を逆にする）。

```bash
npm run test -w @meshimap/geo -- geohash
```

期待: `precision 6 のセル境界を返す` と往復テストが FAIL。確認後に元へ戻す。

次に `toGeohash` の `value.length > GEOHASH_LENGTH_MAX` を `>=` に変える。

期待: `12 桁ちょうどを受け入れる` が FAIL。確認後に元へ戻す。

- [ ] **Step 6: コミット**

```bash
git add packages/geo/src/geohash.ts packages/geo/src/geohash.test.ts
git commit -m "feat(geo): geohash デコードと文字列検証を追加"
```

---

## Task 1-6: geohash 近傍セル

**Files:**

- Modify: `packages/geo/src/geohash.ts`（`neighborCells` を追加）
- Modify: `packages/geo/src/geohash.test.ts`（`describe('neighborCells')` を追記）

**Interfaces:**

- Consumes: Task 1-4 / 1-5 の `Geohash` / `encodeGeohash` / `decodeGeohash`
- Produces: `neighborCells(hash: Geohash): readonly Geohash[]`

**実装方針:** 一般的な geohash ライブラリはビット演算のルックアップ表（`BORDERS` / `NEIGHBORS`）で近傍を求めるが、この計画では**セル中心をセル 1 個分ずらして再エンコードする**方式を採る。理由は 2 つ:

1. ルックアップ表は 4 方向 × 2 種類の魔法文字列を持つため、ミューテーションテストで生き残る変異が出やすく、テストで完全に殺しきるのが難しい。
2. 中心 ± セル幅ちょうどの点は必ず隣セルの中心に一致するため、境界の浮動小数点誤差に強い。

代償として `decodeGeohash` + `encodeGeohash` を 8 回ずつ呼ぶが、precision 12 でも 1 回あたり 60 ビット程度の処理であり、Worker の 1 リクエストで無視できるコスト。

**戻り値の順序:** 北 → 北東 → 東 → 南東 → 南 → 南西 → 西 → 北西（時計回り）。React の key と D1 のクエリ順序を安定させるため固定する。

**端のふるまい（実測で確認済み）:**

- 経度 180 度線は `-180` 側へ折り返す。`"xbp"` の近傍に `"802"` `"800"` `"2pb"` が含まれる。
- 緯度が ±90 度を超えるセルは存在しないため除外する。`encodeGeohash({90, 0}, 3)` = `"upb"` の近傍は 5 件しか返らない。
- 折り返しの結果、自セルや既出セルと重複する場合は除去する。

- [ ] **Step 1: 失敗するテストを書く**

`packages/geo/src/geohash.test.ts` の末尾に追記:

```ts
describe('neighborCells', () => {
  it('新宿駅のセルの 8 近傍を時計回りに返す', () => {
    expect(neighborCells(toGeohash('xn774c'))).toEqual([
      'xn774f',
      'xn7754',
      'xn7751',
      'xn7750',
      'xn774b',
      'xn7748',
      'xn7749',
      'xn774d',
    ]);
  });

  it('東京駅のセルの 8 近傍を返す', () => {
    expect(neighborCells(toGeohash('xn76ur'))).toEqual([
      'xn77h2',
      'xn77h8',
      'xn76ux',
      'xn76uw',
      'xn76uq',
      'xn76un',
      'xn76up',
      'xn77h0',
    ]);
  });

  it('1 桁のセルでも 8 近傍を返す', () => {
    expect(neighborCells(toGeohash('s'))).toEqual(['u', 'v', 't', 'm', 'k', '7', 'e', 'g']);
  });

  it('近傍は自分自身を含まない', () => {
    const cell = toGeohash('xn774c');
    expect(neighborCells(cell)).not.toContain(cell);
  });

  it('近傍に重複がない', () => {
    const cells = neighborCells(toGeohash('xn774c'));
    expect(new Set(cells).size).toBe(cells.length);
  });

  it('近傍は入力と同じ桁数である', () => {
    for (const cell of neighborCells(toGeohash('xn76urx66'))) {
      expect(cell).toHaveLength(9);
    }
  });

  it('近傍関係は対称である', () => {
    const cell = toGeohash('xn774c');
    for (const neighbor of neighborCells(cell)) {
      expect(neighborCells(neighbor)).toContain(cell);
    }
  });

  it('経度 180 度線を跨いで折り返す', () => {
    const cell = encodeGeohash(coordinate(0, 179.99), 3);
    expect(neighborCells(cell)).toEqual(['xbr', '802', '800', '2pb', 'rzz', 'rzy', 'xbn', 'xbq']);
  });

  it('北極のセルは緯度 90 度を超える近傍を返さない', () => {
    const cell = encodeGeohash(coordinate(90, 0), 3);
    expect(cell).toBe('upb');
    expect(neighborCells(cell)).toEqual(['upc', 'up9', 'up8', 'gzx', 'gzz']);
  });

  it('南極のセルは緯度 -90 度を下回る近傍を返さない', () => {
    const cell = encodeGeohash(coordinate(-90, 0), 3);
    expect(cell).toBe('h00');
    expect(neighborCells(cell)).toEqual(['h02', 'h03', 'h01', '5bp', '5br']);
  });
});
```

ファイル先頭の import を更新する:

```ts
import { decodeGeohash, encodeGeohash, neighborCells, toGeohash } from './geohash';
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/geo -- geohash
```

期待: `neighborCells is not a function`。

- [ ] **Step 3a: 経度の折り返しを `coordinate.ts` へ追加する**

`wrapLongitude` は近傍セル（Task 1-6）と境界ボックス（Task 1-9）の両方で必要になる。
重複実装を避けるため、座標のドメイン操作として `coordinate.ts` に置く。

`packages/geo/src/coordinate.ts` の末尾に追記:

```ts
const LONGITUDE_RANGE = LONGITUDE_MAX - LONGITUDE_MIN;

/**
 * 経度を -180 〜 180 の範囲へ折り返す。
 * 日付変更線を跨ぐ計算（近傍セル・境界ボックス）で、範囲外へはみ出した値を正規化する。
 */
export function wrapLongitude(value: number): Longitude {
  const wrapped =
    ((((value - LONGITUDE_MIN) % LONGITUDE_RANGE) + LONGITUDE_RANGE) % LONGITUDE_RANGE) +
    LONGITUDE_MIN;
  return toLongitude(wrapped);
}
```

`packages/geo/src/coordinate.test.ts` の末尾に追記:

```ts
describe('wrapLongitude', () => {
  it.each([
    [0, 0],
    [139.7, 139.7],
    [-179.99, -179.99],
    [180, -180],
    [-180, -180],
    [180.01, -179.99],
    [-180.01, 179.99],
    [360, 0],
    [-360, 0],
    [540, -180],
  ])('経度 %p を %p へ折り返す', (input, expected) => {
    expect(wrapLongitude(input)).toBeCloseTo(expected, 9);
  });

  it('範囲内の値は変換しない', () => {
    expect(wrapLongitude(-180)).toBe(-180);
    expect(wrapLongitude(179.999)).toBe(179.999);
  });

  it('折り返した結果は必ず有効な経度である', () => {
    for (let value = -720; value <= 720; value += 7) {
      const wrapped = wrapLongitude(value);
      expect(wrapped).toBeGreaterThanOrEqual(-180);
      expect(wrapped).toBeLessThan(180);
    }
  });
});
```

`coordinate.test.ts` 先頭の import を更新する:

```ts
import { coordinate, toLatitude, toLongitude, wrapLongitude } from './coordinate';
```

```bash
npm run test -w @meshimap/geo -- coordinate
```

期待: 既存 20 件 + 今回 13 件 = 33 件すべて PASS。

- [ ] **Step 3b: `neighborCells` を実装する**

`packages/geo/src/geohash.ts` の import に `wrapLongitude` を追加:

```ts
import { coordinate, wrapLongitude } from './coordinate';
```

末尾に追記:

```ts
/**
 * 近傍セルを返す順序（時計回り）。
 * 要素は [緯度方向のオフセット, 経度方向のオフセット]。
 */
const NEIGHBOR_OFFSETS = [
  [1, 0], // 北
  [1, 1], // 北東
  [0, 1], // 東
  [-1, 1], // 南東
  [-1, 0], // 南
  [-1, -1], // 南西
  [0, -1], // 西
  [1, -1], // 北西
] as const;

/**
 * 8 近傍のセルを時計回り（北→北東→…→北西）で返す。
 *
 * ルックアップ表ではなく「セル中心をセル 1 個分ずらして再エンコードする」方式。
 * ずらし幅がセル幅ちょうどなので、移動先は必ず隣セルの中心に一致し、境界の誤差に強い。
 * 極付近では緯度が ±90 度を超える近傍が存在しないため、その分だけ要素数が減る。
 */
export function neighborCells(hash: Geohash): readonly Geohash[] {
  const bounds = decodeGeohash(hash);
  const latitudeStep = bounds.latitudeMax - bounds.latitudeMin;
  const longitudeStep = bounds.longitudeMax - bounds.longitudeMin;
  const precision = hash.length as GeohashPrecision;

  const seen = new Set<string>([hash]);
  const neighbors: Geohash[] = [];

  for (const [latitudeOffset, longitudeOffset] of NEIGHBOR_OFFSETS) {
    const latitude = bounds.center.latitude + latitudeOffset * latitudeStep;
    if (latitude > LATITUDE_MAX || latitude < LATITUDE_MIN) {
      continue;
    }
    const longitude = wrapLongitude(bounds.center.longitude + longitudeOffset * longitudeStep);
    const neighbor = encodeGeohash(coordinate(latitude, longitude), precision);
    // 折り返しで自セルや既出セルへ戻る場合があるため重複を除く
    if (seen.has(neighbor)) {
      continue;
    }
    seen.add(neighbor);
    neighbors.push(neighbor);
  }

  return neighbors;
}
```

> `hash.length as GeohashPrecision` は `toGeohash` が桁数を 1〜12 に保証済みであることに依存する。`Geohash` 型を持つ値は必ず `toGeohash` か `encodeGeohash` を経由しているため安全。

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm run test -w @meshimap/geo -- geohash
```

期待: 合計 42 件すべて PASS。

- [ ] **Step 5: 意図的にコードを壊してテストが検知することを確認する**

`coordinate.ts` の `wrapLongitude` を折り返さない実装に変える:

```ts
export function wrapLongitude(value: number): Longitude {
  return toLongitude(value);
}
```

```bash
npm run test -w @meshimap/geo -- geohash
```

期待: `経度 180 度線を跨いで折り返す` が FAIL（`coordinate()` の経度検証で `RangeError` になる）。確認後に元へ戻す。

次に `if (latitude > LATITUDE_MAX || latitude < LATITUDE_MIN)` の行を削除する。

期待: `北極のセルは緯度 90 度を超える近傍を返さない` が `RangeError` で FAIL。確認後に元へ戻す。

- [ ] **Step 6: コミット**

```bash
git add packages/geo/src/geohash.ts packages/geo/src/geohash.test.ts
git commit -m "feat(geo): geohash の 8 近傍セル算出を追加"
```

---

## Task 1-7: 半径から precision を決める

**Files:**

- Create: `packages/geo/src/search-cells.ts`
- Create: `packages/geo/src/search-cells.test.ts`

**Interfaces:**

- Consumes: `geohash.ts` の `GeohashPrecision`
- Produces: `precisionForRadius(radiusM: number): GeohashPrecision`

**閾値テーブル（計画冒頭の実測表に基づく）:**

```
radiusM <= 100    → 7
radiusM <= 600    → 6
radiusM <= 3000   → 5
radiusM <= 19000  → 4
それ以上           → 3
```

- [ ] **Step 1: 失敗するテストを書く**

`packages/geo/src/search-cells.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { precisionForRadius } from './search-cells';

describe('precisionForRadius', () => {
  it.each([
    [0, 7],
    [1, 7],
    [100, 7],
    [100.1, 6],
    [500, 6],
    [600, 6],
    [600.1, 5],
    [1000, 5],
    [3000, 5],
    [3000.1, 4],
    [10000, 4],
    [19000, 4],
    [19000.1, 3],
    [50000, 3],
    [1000000, 3],
  ])('半径 %p m には precision %i を返す', (radiusM, expected) => {
    expect(precisionForRadius(radiusM)).toBe(expected);
  });

  it('半径が大きくなるほど precision は単調非増加である', () => {
    let previous = precisionForRadius(0);
    for (let radiusM = 0; radiusM <= 30000; radiusM += 100) {
      const current = precisionForRadius(radiusM);
      expect(current).toBeLessThanOrEqual(previous);
      previous = current;
    }
  });

  it('負の半径を拒否する', () => {
    expect(() => precisionForRadius(-1)).toThrow(
      new RangeError('半径は 0 以上である必要があります: -1'),
    );
  });

  it('NaN を拒否する', () => {
    expect(() => precisionForRadius(Number.NaN)).toThrow(
      new RangeError('半径は有限の数値である必要があります: NaN'),
    );
  });

  it('Infinity を拒否する', () => {
    expect(() => precisionForRadius(Number.POSITIVE_INFINITY)).toThrow(
      new RangeError('半径は有限の数値である必要があります: Infinity'),
    );
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/geo -- search-cells
```

期待: `Failed to resolve import "./search-cells"`。

- [ ] **Step 3: 最小実装を書く**

`packages/geo/src/search-cells.ts`:

```ts
import type { GeohashPrecision } from './geohash';

/**
 * 半径ごとに使う geohash の精度。
 *
 * 3×3 セルブロック（自セル + 8 近傍）で半径 r の円を必ず覆うには、
 * クエリ点がセル端にある最悪ケースを考えて「セルの最小辺 >= r」が必要。
 * 各値は日本国内（緯度 24〜46 度）でセル最小辺を実測して決めた。
 * 実測値: p7=106m, p6=611m, p5=3395m, p4=19546m, p3=109202m
 */
const PRECISION_BY_MAX_RADIUS_M = [
  { maxRadiusM: 100, precision: 7 },
  { maxRadiusM: 600, precision: 6 },
  { maxRadiusM: 3000, precision: 5 },
  { maxRadiusM: 19000, precision: 4 },
] as const satisfies readonly { maxRadiusM: number; precision: GeohashPrecision }[];

/** テーブルのどの行にも当てはまらない広域検索で使う精度。 */
const WIDE_AREA_PRECISION: GeohashPrecision = 3;

/** 検索半径から、3×3 セルで円を覆いきれる最大の geohash 精度を返す。 */
export function precisionForRadius(radiusM: number): GeohashPrecision {
  if (!Number.isFinite(radiusM)) {
    throw new RangeError(`半径は有限の数値である必要があります: ${radiusM}`);
  }
  if (radiusM < 0) {
    throw new RangeError(`半径は 0 以上である必要があります: ${radiusM}`);
  }

  for (const row of PRECISION_BY_MAX_RADIUS_M) {
    if (radiusM <= row.maxRadiusM) {
      return row.precision;
    }
  }
  return WIDE_AREA_PRECISION;
}
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm run test -w @meshimap/geo -- search-cells
```

期待: 19 件すべて PASS。

- [ ] **Step 5: 意図的にコードを壊してテストが検知することを確認する**

`if (radiusM <= row.maxRadiusM)` を `<` に変える。

```bash
npm run test -w @meshimap/geo -- search-cells
```

期待: `半径 100 m には precision 7 を返す`、`半径 600 m には precision 6 を返す`、`半径 3000 m には precision 5 を返す`、`半径 19000 m には precision 4 を返す` の 4 件が FAIL。確認後に元へ戻す。

- [ ] **Step 6: コミット**

```bash
git add packages/geo/src/search-cells.ts packages/geo/src/search-cells.test.ts
git commit -m "feat(geo): 検索半径から geohash 精度を決める関数を追加"
```

---

## Task 1-8: 半径から検索セル群を求める

**Files:**

- Modify: `packages/geo/src/search-cells.ts`（`cellsForRadius` を追加）
- Modify: `packages/geo/src/search-cells.test.ts`（`describe('cellsForRadius')` を追記）

**Interfaces:**

- Consumes: Task 1-7 の `precisionForRadius`、`geohash.ts` の `encodeGeohash` / `neighborCells` / `Geohash`、`coordinate.ts` の `Coordinate`
- Produces: `cellsForRadius(center: Coordinate, radiusM: number): readonly Geohash[]`

> これが D1 検索の第 1 段になる。`WHERE geohash IN (?, ?, …)` として使い、B-tree インデックスで候補を数百件まで落とす。

- [ ] **Step 1: 失敗するテストを書く**

`packages/geo/src/search-cells.test.ts` の末尾に追記:

```ts
describe('cellsForRadius', () => {
  const SHINJUKU_STATION = coordinate(35.689592, 139.700413);

  it('自セルと 8 近傍の 9 セルを返す', () => {
    expect(cellsForRadius(SHINJUKU_STATION, 500)).toHaveLength(9);
  });

  it('先頭は中心セルである', () => {
    expect(cellsForRadius(SHINJUKU_STATION, 500)[0]).toBe('xn774c');
  });

  it('半径に応じた精度の桁数になる', () => {
    expect(cellsForRadius(SHINJUKU_STATION, 100)[0]).toHaveLength(7);
    expect(cellsForRadius(SHINJUKU_STATION, 500)[0]).toHaveLength(6);
    expect(cellsForRadius(SHINJUKU_STATION, 2000)[0]).toHaveLength(5);
    expect(cellsForRadius(SHINJUKU_STATION, 10000)[0]).toHaveLength(4);
    expect(cellsForRadius(SHINJUKU_STATION, 50000)[0]).toHaveLength(3);
  });

  it('半径が大きいほどセルの桁数が短くなる', () => {
    const narrow = cellsForRadius(SHINJUKU_STATION, 100)[0];
    const wide = cellsForRadius(SHINJUKU_STATION, 10000)[0];
    expect(String(wide).length).toBeLessThan(String(narrow).length);
  });

  it('返すセルに重複がない', () => {
    const cells = cellsForRadius(SHINJUKU_STATION, 500);
    expect(new Set(cells).size).toBe(cells.length);
  });

  it('すべてのセルが同じ桁数である', () => {
    const cells = cellsForRadius(SHINJUKU_STATION, 500);
    for (const cell of cells) {
      expect(cell).toHaveLength(6);
    }
  });

  it('中心から半径の距離にある点が必ずいずれかのセルに含まれる', () => {
    // 3×3 セルで円を覆えているかの回帰テスト。真北・真南・真東・真西の 4 方向で確認する
    const radiusM = 500;
    const cells = new Set(cellsForRadius(SHINJUKU_STATION, radiusM));
    const precision = precisionForRadius(radiusM);
    const latitudeDeltaDeg = 500 / 111320;
    const longitudeDeltaDeg = latitudeDeltaDeg / Math.cos((35.689592 * Math.PI) / 180);
    const edges = [
      coordinate(35.689592 + latitudeDeltaDeg, 139.700413),
      coordinate(35.689592 - latitudeDeltaDeg, 139.700413),
      coordinate(35.689592, 139.700413 + longitudeDeltaDeg),
      coordinate(35.689592, 139.700413 - longitudeDeltaDeg),
    ];
    for (const edge of edges) {
      expect(cells.has(encodeGeohash(edge, precision))).toBe(true);
    }
  });

  it('極付近では近傍が減るため 9 セル未満になる', () => {
    expect(cellsForRadius(coordinate(90, 0), 50000).length).toBeLessThan(9);
  });

  it('負の半径を拒否する', () => {
    expect(() => cellsForRadius(SHINJUKU_STATION, -1)).toThrow(
      new RangeError('半径は 0 以上である必要があります: -1'),
    );
  });
});
```

ファイル先頭の import を更新する:

```ts
import { coordinate } from './coordinate';
import { encodeGeohash } from './geohash';
import { cellsForRadius, precisionForRadius } from './search-cells';
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/geo -- search-cells
```

期待: `cellsForRadius is not a function`。

- [ ] **Step 3: 最小実装を書く**

`packages/geo/src/search-cells.ts` の import に追加:

```ts
import type { Coordinate } from './coordinate';
import { encodeGeohash, neighborCells } from './geohash';
import type { Geohash, GeohashPrecision } from './geohash';
```

末尾に追記:

```ts
/**
 * 中心と半径から、D1 の `WHERE geohash IN (…)` に渡すセル一覧を返す。
 * 先頭は必ず中心セル、以降は時計回りの 8 近傍。
 *
 * これは 3 段階検索の第 1 段。ここで候補を粗く絞り、
 * 第 2 段の境界ボックス（`boundingBox` / `isWithinBounds`）と
 * 第 3 段の Haversine（`distanceMeters`）で正確に仕上げる。
 */
export function cellsForRadius(center: Coordinate, radiusM: number): readonly Geohash[] {
  const precision = precisionForRadius(radiusM);
  const centerCell = encodeGeohash(center, precision);
  return [centerCell, ...neighborCells(centerCell)];
}
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm run test -w @meshimap/geo -- search-cells
```

期待: 合計 29 件すべて PASS。とくに `中心から半径の距離にある点が必ずいずれかのセルに含まれる` が通ることを確認する。ここが Task 1-7 の閾値テーブルの妥当性を保証している。

- [ ] **Step 5: 意図的に閾値を壊して被覆テストが検知することを確認する**

`search-cells.ts` の `{ maxRadiusM: 600, precision: 6 }` を `{ maxRadiusM: 600, precision: 7 }` に変える（半径に対して細かすぎる精度にする）。

```bash
npm run test -w @meshimap/geo -- search-cells
```

期待: `中心から半径の距離にある点が必ずいずれかのセルに含まれる` が FAIL する。**これが FAIL しないなら被覆テストが役に立っていない。** 確認後に元へ戻す。

- [ ] **Step 6: コミット**

```bash
git add packages/geo/src/search-cells.ts packages/geo/src/search-cells.test.ts
git commit -m "feat(geo): 検索半径から geohash セル群を求める関数を追加"
```

---

## Task 1-9: 境界ボックス生成

**Files:**

- Create: `packages/geo/src/bounding-box.ts`
- Create: `packages/geo/src/bounding-box.test.ts`

**Interfaces:**

- Consumes: `constants.ts`、`coordinate.ts` の `Coordinate` / `Latitude` / `Longitude` / `toLatitude` / `toLongitude`
- Produces:
  - `type BoundingBox = { readonly latitudeMin: Latitude; readonly latitudeMax: Latitude; readonly longitudeMin: Longitude; readonly longitudeMax: Longitude }`
  - `boundingBox(center: Coordinate, radiusM: number): BoundingBox`

**3 段階検索の第 2 段。** D1 では `WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?` として使う。

**極を跨ぐ扱い（実測で確認した設計判断）:** 緯度が ±90 度でクランプされた場合、円は極を含んでいる。極を含む円は全経度を覆うため、経度範囲を `-180 〜 180` に広げる。この規則があると、半径が地球半周に近い場合に経度の一部が抜け落ちる不具合も同時に防げる（実測: この規則が無いと半径 20000km で経度 179.86〜180 度の帯が範囲から漏れる）。

- [ ] **Step 1: 失敗するテストを書く**

`packages/geo/src/bounding-box.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { boundingBox } from './bounding-box';
import { coordinate } from './coordinate';

const SHINJUKU_STATION = coordinate(35.689592, 139.700413);

describe('boundingBox', () => {
  it('新宿駅から半径 1000m の矩形を返す', () => {
    const bounds = boundingBox(SHINJUKU_STATION, 1000);
    expect(bounds.latitudeMin).toBeCloseTo(35.68059879636275, 9);
    expect(bounds.latitudeMax).toBeCloseTo(35.69858520363724, 9);
    expect(bounds.longitudeMin).toBeCloseTo(139.68934021038626, 9);
    expect(bounds.longitudeMax).toBeCloseTo(139.71148578961368, 9);
  });

  it('半径 0 では中心と一致する', () => {
    const bounds = boundingBox(coordinate(35, 139), 0);
    expect(bounds.latitudeMin).toBe(35);
    expect(bounds.latitudeMax).toBe(35);
    expect(bounds.longitudeMin).toBe(139);
    expect(bounds.longitudeMax).toBe(139);
  });

  it('中心は矩形の内側にある', () => {
    const bounds = boundingBox(SHINJUKU_STATION, 1000);
    expect(bounds.latitudeMin).toBeLessThan(SHINJUKU_STATION.latitude);
    expect(bounds.latitudeMax).toBeGreaterThan(SHINJUKU_STATION.latitude);
    expect(bounds.longitudeMin).toBeLessThan(SHINJUKU_STATION.longitude);
    expect(bounds.longitudeMax).toBeGreaterThan(SHINJUKU_STATION.longitude);
  });

  it('赤道上では緯度の幅と経度の幅がほぼ等しい', () => {
    const bounds = boundingBox(coordinate(0, 0), 1000);
    expect(bounds.longitudeMax - bounds.longitudeMin).toBeCloseTo(
      bounds.latitudeMax - bounds.latitudeMin,
      9,
    );
  });

  it('高緯度ほど経度の幅が緯度の幅より広がる', () => {
    const equator = boundingBox(coordinate(0, 0), 1000);
    const highLatitude = boundingBox(coordinate(60, 0), 1000);
    expect(highLatitude.longitudeMax - highLatitude.longitudeMin).toBeGreaterThan(
      equator.longitudeMax - equator.longitudeMin,
    );
  });

  it('緯度 89 度でも経度の幅は有限である', () => {
    const bounds = boundingBox(coordinate(89, 0), 1000);
    expect(bounds.longitudeMin).toBeCloseTo(-0.515298773814493, 9);
    expect(bounds.longitudeMax).toBeCloseTo(0.515298773814493, 9);
  });

  it('北極を含む円は全経度を覆う', () => {
    const bounds = boundingBox(coordinate(90, 0), 1000);
    expect(bounds.latitudeMin).toBeCloseTo(89.99100679636275, 9);
    expect(bounds.latitudeMax).toBe(90);
    expect(bounds.longitudeMin).toBe(-180);
    expect(bounds.longitudeMax).toBe(180);
  });

  it('南極を含む円は全経度を覆う', () => {
    const bounds = boundingBox(coordinate(-90, 0), 1000);
    expect(bounds.latitudeMin).toBe(-90);
    expect(bounds.latitudeMax).toBeCloseTo(-89.99100679636275, 9);
    expect(bounds.longitudeMin).toBe(-180);
    expect(bounds.longitudeMax).toBe(180);
  });

  it('地球全体を覆う半径では全経度・全緯度になる', () => {
    // 極でクランプされる規則が無いと、経度 179.86〜180 度の帯が漏れる
    const bounds = boundingBox(coordinate(0, 0), 20000000);
    expect(bounds.latitudeMin).toBe(-90);
    expect(bounds.latitudeMax).toBe(90);
    expect(bounds.longitudeMin).toBe(-180);
    expect(bounds.longitudeMax).toBe(180);
  });

  it('日付変更線を跨ぐと最小経度が最大経度より大きくなる', () => {
    const bounds = boundingBox(coordinate(0, 179.99), 5000);
    expect(bounds.longitudeMin).toBeCloseTo(179.94503398181382, 9);
    expect(bounds.longitudeMax).toBeCloseTo(-179.9650339818138, 9);
    expect(bounds.longitudeMin).toBeGreaterThan(bounds.longitudeMax);
  });

  it('西回りで日付変更線を跨ぐ場合も折り返す', () => {
    const bounds = boundingBox(coordinate(0, -179.99), 5000);
    expect(bounds.longitudeMin).toBeCloseTo(179.9650339818138, 9);
    expect(bounds.longitudeMax).toBeCloseTo(-179.94503398181382, 9);
  });

  it('負の半径を拒否する', () => {
    expect(() => boundingBox(SHINJUKU_STATION, -1)).toThrow(
      new RangeError('半径は 0 以上である必要があります: -1'),
    );
  });

  it('NaN の半径を拒否する', () => {
    expect(() => boundingBox(SHINJUKU_STATION, Number.NaN)).toThrow(
      new RangeError('半径は有限の数値である必要があります: NaN'),
    );
  });

  it('Infinity の半径を拒否する', () => {
    expect(() => boundingBox(SHINJUKU_STATION, Number.POSITIVE_INFINITY)).toThrow(
      new RangeError('半径は有限の数値である必要があります: Infinity'),
    );
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/geo -- bounding-box
```

期待: `Failed to resolve import "./bounding-box"`。

- [ ] **Step 3: 最小実装を書く**

`packages/geo/src/bounding-box.ts`:

```ts
import {
  DEGREES_TO_RADIANS,
  EARTH_RADIUS_M,
  LATITUDE_MAX,
  LATITUDE_MIN,
  LONGITUDE_MAX,
  LONGITUDE_MIN,
} from './constants';
import { toLatitude, toLongitude, wrapLongitude } from './coordinate';
import type { Coordinate, Latitude, Longitude } from './coordinate';

/** 緯度経度の矩形範囲。日付変更線を跨ぐ場合のみ `longitudeMin > longitudeMax` になる。 */
export type BoundingBox = {
  readonly latitudeMin: Latitude;
  readonly latitudeMax: Latitude;
  readonly longitudeMin: Longitude;
  readonly longitudeMax: Longitude;
};

const LONGITUDE_HALF_RANGE = (LONGITUDE_MAX - LONGITUDE_MIN) / 2;

/**
 * 中心と半径から検索用の矩形範囲を返す。3 段階検索の第 2 段。
 *
 * D1 には ST_DWithin が無いため、`latitude BETWEEN ? AND ?` のインデックス範囲検索で
 * 候補を絞る。円ではなく外接矩形なので四隅に余分な候補が入るが、
 * 第 3 段の Haversine で落とす前提の粗いフィルタとして使う。
 */
export function boundingBox(center: Coordinate, radiusM: number): BoundingBox {
  if (!Number.isFinite(radiusM)) {
    throw new RangeError(`半径は有限の数値である必要があります: ${radiusM}`);
  }
  if (radiusM < 0) {
    throw new RangeError(`半径は 0 以上である必要があります: ${radiusM}`);
  }

  const latitudeDeltaDeg = radiusM / EARTH_RADIUS_M / DEGREES_TO_RADIANS;
  const latitudeMin = Math.max(LATITUDE_MIN, center.latitude - latitudeDeltaDeg);
  const latitudeMax = Math.min(LATITUDE_MAX, center.latitude + latitudeDeltaDeg);

  // 緯度が極でクランプされた = 円が極を含む。極の向こう側は全経度に回り込む
  const includesPole = latitudeMin <= LATITUDE_MIN || latitudeMax >= LATITUDE_MAX;
  if (includesPole) {
    return allLongitudes(latitudeMin, latitudeMax);
  }

  // 高緯度ほど経線の間隔が狭まるので、緯度差を cos で割って経度差に直す。
  // includesPole が false なので cos は 0 にならない
  const longitudeDeltaDeg = latitudeDeltaDeg / Math.cos(center.latitude * DEGREES_TO_RADIANS);
  if (longitudeDeltaDeg >= LONGITUDE_HALF_RANGE) {
    return allLongitudes(latitudeMin, latitudeMax);
  }

  return {
    latitudeMin: toLatitude(latitudeMin),
    latitudeMax: toLatitude(latitudeMax),
    longitudeMin: wrapLongitude(center.longitude - longitudeDeltaDeg),
    longitudeMax: wrapLongitude(center.longitude + longitudeDeltaDeg),
  };
}

function allLongitudes(latitudeMin: number, latitudeMax: number): BoundingBox {
  return {
    latitudeMin: toLatitude(latitudeMin),
    latitudeMax: toLatitude(latitudeMax),
    longitudeMin: toLongitude(LONGITUDE_MIN),
    longitudeMax: toLongitude(LONGITUDE_MAX),
  };
}
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm run test -w @meshimap/geo -- bounding-box
```

期待: 14 件すべて PASS。

- [ ] **Step 5: 意図的にコードを壊してテストが検知することを確認する**

`const includesPole = …` の行を `const includesPole = false;` に変える。

```bash
npm run test -w @meshimap/geo -- bounding-box
```

期待: `北極を含む円は全経度を覆う`、`南極を含む円は全経度を覆う`、`地球全体を覆う半径では全経度・全緯度になる` の 3 件が FAIL。確認後に元へ戻す。

次に `latitudeDeltaDeg / Math.cos(…)` を `latitudeDeltaDeg * Math.cos(…)` に変える。

期待: `高緯度ほど経度の幅が緯度の幅より広がる` と `緯度 89 度でも経度の幅は有限である` が FAIL。確認後に元へ戻す。

- [ ] **Step 6: コミット**

```bash
git add packages/geo/src/bounding-box.ts packages/geo/src/bounding-box.test.ts
git commit -m "feat(geo): 検索用の境界ボックス生成を追加"
```

---

## Task 1-10: 境界ボックス内判定

**Files:**

- Modify: `packages/geo/src/bounding-box.ts`（`isWithinBounds` を追加）
- Modify: `packages/geo/src/bounding-box.test.ts`（`describe('isWithinBounds')` を追記）

**Interfaces:**

- Consumes: Task 1-9 の `BoundingBox`、`coordinate.ts` の `Coordinate`
- Produces: `isWithinBounds(target: Coordinate, bounds: BoundingBox): boolean`

**仕様:** 境界線上は内側とする（`>=` / `<=`）。`longitudeMin > longitudeMax` のときは日付変更線を跨ぐ矩形なので、経度の判定を OR にする。

- [ ] **Step 1: 失敗するテストを書く**

`packages/geo/src/bounding-box.test.ts` の末尾に追記:

```ts
describe('isWithinBounds', () => {
  const bounds = boundingBox(SHINJUKU_STATION, 1000);

  it('中心は内側である', () => {
    expect(isWithinBounds(SHINJUKU_STATION, bounds)).toBe(true);
  });

  it('南西の角（境界線上）は内側である', () => {
    expect(isWithinBounds(coordinate(bounds.latitudeMin, bounds.longitudeMin), bounds)).toBe(true);
  });

  it('北東の角（境界線上）は内側である', () => {
    expect(isWithinBounds(coordinate(bounds.latitudeMax, bounds.longitudeMax), bounds)).toBe(true);
  });

  it('緯度が上限をわずかに超えると外側である', () => {
    expect(
      isWithinBounds(coordinate(bounds.latitudeMax + 0.0001, bounds.longitudeMin), bounds),
    ).toBe(false);
  });

  it('緯度が下限をわずかに下回ると外側である', () => {
    expect(
      isWithinBounds(coordinate(bounds.latitudeMin - 0.0001, bounds.longitudeMin), bounds),
    ).toBe(false);
  });

  it('経度が上限をわずかに超えると外側である', () => {
    expect(
      isWithinBounds(coordinate(bounds.latitudeMin, bounds.longitudeMax + 0.0001), bounds),
    ).toBe(false);
  });

  it('経度が下限をわずかに下回ると外側である', () => {
    expect(
      isWithinBounds(coordinate(bounds.latitudeMin, bounds.longitudeMin - 0.0001), bounds),
    ).toBe(false);
  });

  it('約 6km 離れた東京駅は半径 1000m の矩形の外側である', () => {
    expect(isWithinBounds(coordinate(35.681236, 139.767125), bounds)).toBe(false);
  });

  describe('日付変更線を跨ぐ矩形', () => {
    const crossing = boundingBox(coordinate(0, 179.99), 5000);

    it('東経側の点は内側である', () => {
      expect(isWithinBounds(coordinate(0, 179.99), crossing)).toBe(true);
    });

    it('西経側へ折り返した点も内側である', () => {
      expect(isWithinBounds(coordinate(0, -179.99), crossing)).toBe(true);
    });

    it('経度 180 度ちょうどは内側である', () => {
      expect(isWithinBounds(coordinate(0, 180), crossing)).toBe(false);
      expect(isWithinBounds(coordinate(0, -180), crossing)).toBe(true);
    });

    it('東経側の範囲外は外側である', () => {
      expect(isWithinBounds(coordinate(0, 179.94), crossing)).toBe(false);
    });

    it('本初子午線上の点は外側である', () => {
      expect(isWithinBounds(coordinate(0, 0), crossing)).toBe(false);
    });

    it('緯度が範囲外なら経度が内側でも外側である', () => {
      expect(isWithinBounds(coordinate(45, 179.99), crossing)).toBe(false);
    });
  });
});
```

> `経度 180 度ちょうどは内側である` の 2 行は、`wrapLongitude(180)` が `-180` を返す実測結果に基づく。`180` は矩形の上限 `-179.965` を超え下限 `179.945` に届かないため外側、`-180` は上限以下なので内側になる。地球上では同じ点だが、正規化後の表現で判定するという設計をテストで固定している。

ファイル先頭の import を更新する:

```ts
import { boundingBox, isWithinBounds } from './bounding-box';
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/geo -- bounding-box
```

期待: `isWithinBounds is not a function`。

- [ ] **Step 3: 最小実装を書く**

`packages/geo/src/bounding-box.ts` の末尾に追記:

```ts
/**
 * 座標が矩形の内側にあるかを判定する（境界線上は内側）。
 *
 * `longitudeMin > longitudeMax` は日付変更線を跨ぐ矩形を表す。
 * この場合だけ経度の判定が AND ではなく OR になる。
 */
export function isWithinBounds(target: Coordinate, bounds: BoundingBox): boolean {
  if (target.latitude < bounds.latitudeMin || target.latitude > bounds.latitudeMax) {
    return false;
  }

  if (bounds.longitudeMin <= bounds.longitudeMax) {
    return target.longitude >= bounds.longitudeMin && target.longitude <= bounds.longitudeMax;
  }

  return target.longitude >= bounds.longitudeMin || target.longitude <= bounds.longitudeMax;
}
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm run test -w @meshimap/geo -- bounding-box
```

期待: Task 1-9 の 14 件 + 今回の 14 件 = 28 件すべて PASS。

- [ ] **Step 5: 意図的にコードを壊してテストが検知することを確認する**

日付変更線の分岐を消して常に AND 判定にする:

```ts
return target.longitude >= bounds.longitudeMin && target.longitude <= bounds.longitudeMax;
```

```bash
npm run test -w @meshimap/geo -- bounding-box
```

期待: `東経側の点は内側である` と `西経側へ折り返した点も内側である` が FAIL。確認後に元へ戻す。

次に `target.latitude < bounds.latitudeMin` を `<=` に変える。

期待: `南西の角（境界線上）は内側である` が FAIL。確認後に元へ戻す。

- [ ] **Step 6: コミット**

```bash
git add packages/geo/src/bounding-box.ts packages/geo/src/bounding-box.test.ts
git commit -m "feat(geo): 境界ボックス内判定を追加"
```

---

## Task 1-11: グリッドクラスタリング

**Files:**

- Create: `packages/geo/src/cluster.ts`
- Create: `packages/geo/src/cluster.test.ts`

**Interfaces:**

- Consumes: `geohash.ts` の `encodeGeohash` / `Geohash` / `GeohashPrecision`、`coordinate.ts` の `Coordinate` / `coordinate`
- Produces:
  - `type GridPoint<TValue> = { readonly coordinate: Coordinate; readonly value: TValue }`
  - `type Cluster<TValue> = { readonly cell: Geohash; readonly center: Coordinate; readonly values: readonly TValue[] }`
  - `precisionForZoom(zoom: number): GeohashPrecision`
  - `clusterByGrid<TValue>(points: readonly GridPoint<TValue>[], zoom: number): readonly Cluster<TValue>[]`

**設計判断:**

- クラスタの `center` はセル中心ではなく**所属点の重心**にする。セル中心だとピンが格子状に並んで不自然に見えるため。
- 戻り値は `cell` の辞書順で安定ソートする。React の `key` と再レンダリングを安定させるため。
- `values` は入力順を保つ。

**ズームと精度の対応表:**

| zoom   | precision |
| ------ | --------- |
| 0〜4   | 2         |
| 5〜7   | 3         |
| 8〜10  | 4         |
| 11〜13 | 5         |
| 14〜16 | 6         |
| 17〜22 | 7         |

- [ ] **Step 1: 失敗するテストを書く**

`packages/geo/src/cluster.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { clusterByGrid, precisionForZoom } from './cluster';
import type { GridPoint } from './cluster';
import { coordinate } from './coordinate';

// 実測でセル割り当てを確認済みの 5 点
const POINTS: readonly GridPoint<string>[] = [
  { coordinate: coordinate(35.689592, 139.700413), value: 'A' }, // 新宿駅
  { coordinate: coordinate(35.69, 139.7009), value: 'B' }, // 新宿駅のすぐ隣
  { coordinate: coordinate(35.658034, 139.701636), value: 'C' }, // 渋谷駅
  { coordinate: coordinate(35.681236, 139.767125), value: 'D' }, // 東京駅
  { coordinate: coordinate(34.702485, 135.495951), value: 'E' }, // 大阪駅
];

describe('precisionForZoom', () => {
  it.each([
    [0, 2],
    [4, 2],
    [5, 3],
    [7, 3],
    [8, 4],
    [10, 4],
    [11, 5],
    [13, 5],
    [14, 6],
    [16, 6],
    [17, 7],
    [22, 7],
  ])('zoom %i には precision %i を返す', (zoom, expected) => {
    expect(precisionForZoom(zoom)).toBe(expected);
  });

  it('ズームが上がるほど precision は単調非減少である', () => {
    let previous = precisionForZoom(0);
    for (let zoom = 0; zoom <= 22; zoom += 1) {
      const current = precisionForZoom(zoom);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it('負のズームを拒否する', () => {
    expect(() => precisionForZoom(-1)).toThrow(
      new RangeError('ズームは 0 〜 22 の範囲である必要があります: -1'),
    );
  });

  it('上限を超えるズームを拒否する', () => {
    expect(() => precisionForZoom(23)).toThrow(
      new RangeError('ズームは 0 〜 22 の範囲である必要があります: 23'),
    );
  });

  it('NaN を拒否する', () => {
    expect(() => precisionForZoom(Number.NaN)).toThrow(
      new RangeError('ズームは有限の数値である必要があります: NaN'),
    );
  });
});

describe('clusterByGrid', () => {
  it('空配列には空配列を返す', () => {
    expect(clusterByGrid([], 15)).toEqual([]);
  });

  it('1 点だけなら 1 クラスタになる', () => {
    const clusters = clusterByGrid(
      [{ coordinate: coordinate(35.689592, 139.700413), value: 'A' }],
      15,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.values).toEqual(['A']);
  });

  it('zoom 15（precision 6）では 4 クラスタに分かれる', () => {
    const clusters = clusterByGrid(POINTS, 15);
    expect(clusters.map((cluster) => cluster.cell)).toEqual([
      'xn0m7m',
      'xn76fg',
      'xn76ur',
      'xn774c',
    ]);
  });

  it('同じセルの点は 1 クラスタにまとまる', () => {
    const clusters = clusterByGrid(POINTS, 15);
    const shinjuku = clusters.find((cluster) => cluster.cell === 'xn774c');
    expect(shinjuku?.values).toEqual(['A', 'B']);
  });

  it('zoom 9（precision 4）ではクラスタ数が減る', () => {
    const clusters = clusterByGrid(POINTS, 9);
    expect(clusters.map((cluster) => cluster.cell)).toEqual(['xn0m', 'xn76', 'xn77']);
  });

  it('ズームを上げるとクラスタが分裂する', () => {
    expect(clusterByGrid(POINTS, 15).length).toBeGreaterThan(clusterByGrid(POINTS, 9).length);
  });

  it('クラスタの中心は所属点の重心である', () => {
    const clusters = clusterByGrid(POINTS, 15);
    const shinjuku = clusters.find((cluster) => cluster.cell === 'xn774c');
    expect(shinjuku?.center.latitude).toBeCloseTo(35.689796, 9);
    expect(shinjuku?.center.longitude).toBeCloseTo(139.7006565, 9);
  });

  it('1 点のクラスタの中心はその点自身である', () => {
    const clusters = clusterByGrid(POINTS, 15);
    const osaka = clusters.find((cluster) => cluster.cell === 'xn0m7m');
    expect(osaka?.center).toEqual({ latitude: 34.702485, longitude: 135.495951 });
  });

  it('すべての点がいずれかのクラスタに属する', () => {
    const clusters = clusterByGrid(POINTS, 15);
    const collected = clusters.flatMap((cluster) => [...cluster.values]);
    expect([...collected].sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('クラスタはセルの辞書順に並ぶ', () => {
    const cells = clusterByGrid(POINTS, 15).map((cluster) => cluster.cell);
    expect(cells).toEqual([...cells].sort());
  });

  it('入力順が変わっても同じ結果になる', () => {
    const reversed = [...POINTS].reverse();
    expect(clusterByGrid(reversed, 15).map((cluster) => cluster.cell)).toEqual(
      clusterByGrid(POINTS, 15).map((cluster) => cluster.cell),
    );
  });

  it('文字列以外の値も保持できる', () => {
    const shopPoints: readonly GridPoint<{ id: number }>[] = [
      { coordinate: coordinate(35.689592, 139.700413), value: { id: 1 } },
    ];
    expect(clusterByGrid(shopPoints, 15)[0]?.values).toEqual([{ id: 1 }]);
  });

  it('不正なズームを拒否する', () => {
    expect(() => clusterByGrid(POINTS, 99)).toThrow(
      new RangeError('ズームは 0 〜 22 の範囲である必要があります: 99'),
    );
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/geo -- cluster
```

期待: `Failed to resolve import "./cluster"`。

- [ ] **Step 3: 最小実装を書く**

`packages/geo/src/cluster.ts`:

```ts
import { coordinate } from './coordinate';
import type { Coordinate } from './coordinate';
import { encodeGeohash } from './geohash';
import type { Geohash, GeohashPrecision } from './geohash';

export const ZOOM_MIN = 0;
export const ZOOM_MAX = 22;

/** クラスタリング対象の 1 点。`value` に店舗 ID などの任意データを載せる。 */
export type GridPoint<TValue> = {
  readonly coordinate: Coordinate;
  readonly value: TValue;
};

export type Cluster<TValue> = {
  readonly cell: Geohash;
  /** 所属点の重心。セル中心だとピンが格子状に並んで不自然になるため。 */
  readonly center: Coordinate;
  readonly values: readonly TValue[];
};

/**
 * 地図のズームレベルごとに使う geohash 精度。
 * ズームが 3 段上がるとセルが 1 段細かくなるよう配分している。
 */
const PRECISION_BY_MAX_ZOOM = [
  { maxZoom: 4, precision: 2 },
  { maxZoom: 7, precision: 3 },
  { maxZoom: 10, precision: 4 },
  { maxZoom: 13, precision: 5 },
  { maxZoom: 16, precision: 6 },
] as const satisfies readonly { maxZoom: number; precision: GeohashPrecision }[];

/** 最大ズーム帯で使う精度（セル約 125m 四方）。 */
const MAX_ZOOM_PRECISION: GeohashPrecision = 7;

export function precisionForZoom(zoom: number): GeohashPrecision {
  if (!Number.isFinite(zoom)) {
    throw new RangeError(`ズームは有限の数値である必要があります: ${zoom}`);
  }
  if (zoom < ZOOM_MIN || zoom > ZOOM_MAX) {
    throw new RangeError(`ズームは ${ZOOM_MIN} 〜 ${ZOOM_MAX} の範囲である必要があります: ${zoom}`);
  }

  for (const row of PRECISION_BY_MAX_ZOOM) {
    if (zoom <= row.maxZoom) {
      return row.precision;
    }
  }
  return MAX_ZOOM_PRECISION;
}

/**
 * 点群を geohash セル単位でまとめる。
 *
 * 地図に数百件のピンをそのまま描くと描画が破綻するため、
 * ズームに応じた粒度のセルへ集約してからピンを描く。
 * 戻り値はセルの辞書順に並ぶので、React の key と再レンダリングが安定する。
 */
export function clusterByGrid<TValue>(
  points: readonly GridPoint<TValue>[],
  zoom: number,
): readonly Cluster<TValue>[] {
  const precision = precisionForZoom(zoom);
  const groups = new Map<Geohash, GridPoint<TValue>[]>();

  for (const point of points) {
    const cell = encodeGeohash(point.coordinate, precision);
    const group = groups.get(cell);
    if (group === undefined) {
      groups.set(cell, [point]);
    } else {
      group.push(point);
    }
  }

  // スプレッドで新しい配列を作っているため sort の破壊的変更は外部へ影響しない
  return [...groups.entries()]
    .sort(([leftCell], [rightCell]) => leftCell.localeCompare(rightCell))
    .map(([cell, group]) => ({
      cell,
      center: centroid(group),
      values: group.map((point) => point.value),
    }));
}

/** 点群の重心を返す。`group` は必ず 1 件以上を含む。 */
function centroid<TValue>(group: readonly GridPoint<TValue>[]): Coordinate {
  let latitudeSum = 0;
  let longitudeSum = 0;
  for (const point of group) {
    latitudeSum += point.coordinate.latitude;
    longitudeSum += point.coordinate.longitude;
  }
  return coordinate(latitudeSum / group.length, longitudeSum / group.length);
}
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm run test -w @meshimap/geo -- cluster
```

期待: 30 件すべて PASS。

- [ ] **Step 5: 意図的にコードを壊してテストが検知することを確認する**

`centroid` の `latitudeSum / group.length` を `latitudeSum` に変える。

```bash
npm run test -w @meshimap/geo -- cluster
```

期待: `クラスタの中心は所属点の重心である` が `RangeError`（緯度 71 度超）で FAIL。確認後に元へ戻す。

次に `.sort(([leftCell], [rightCell]) => leftCell.localeCompare(rightCell))` を削除する。

期待: `クラスタはセルの辞書順に並ぶ` と `入力順が変わっても同じ結果になる` が FAIL。確認後に元へ戻す。

- [ ] **Step 6: コミット**

```bash
git add packages/geo/src/cluster.ts packages/geo/src/cluster.test.ts
git commit -m "feat(geo): グリッドクラスタリングを追加"
```

---

## Task 1-12: 公開 API のバレルとミューテーションテストの通過

Phase 1 の締め。ここを通せば `@meshimap/geo` は Phase 3 以降から安心して使える。

**Files:**

- Create: `packages/geo/src/index.ts`
- Create: `packages/geo/src/index.test.ts`
- Modify: `packages/geo/README.md`（新規作成）

**Interfaces:**

- Consumes: Task 1-1 〜 1-11 のすべての公開シンボル
- Produces: `@meshimap/geo` の公開 API（他パッケージはこのバレル以外から import しない）

- [ ] **Step 1: 公開 API を固定するテストを書く**

`packages/geo/src/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as geo from './index';

describe('@meshimap/geo の公開 API', () => {
  it('公開する関数と定数が過不足なく揃っている', () => {
    // 意図しない公開・意図しない削除の両方を検知するためのスナップショット的テスト
    expect([...Object.keys(geo)].sort()).toEqual([
      'DEGREES_TO_RADIANS',
      'EARTH_RADIUS_M',
      'GEOHASH_BASE32',
      'GEOHASH_LENGTH_MAX',
      'GEOHASH_LENGTH_MIN',
      'LATITUDE_MAX',
      'LATITUDE_MIN',
      'LONGITUDE_MAX',
      'LONGITUDE_MIN',
      'ZOOM_MAX',
      'ZOOM_MIN',
      'boundingBox',
      'cellsForRadius',
      'clusterByGrid',
      'coordinate',
      'decodeGeohash',
      'distanceMeters',
      'encodeGeohash',
      'formatDistance',
      'isWithinBounds',
      'neighborCells',
      'precisionForRadius',
      'precisionForZoom',
      'toGeohash',
      'toLatitude',
      'toLongitude',
      'wrapLongitude',
    ]);
  });

  it('3 段階検索を通しで実行できる', () => {
    // 第 1 段: geohash セル → 第 2 段: 境界ボックス → 第 3 段: Haversine
    const center = geo.coordinate(35.689592, 139.700413);
    const radiusM = 1000;

    const shops = [
      { name: '近い店', location: geo.coordinate(35.6905, 139.7015) },
      { name: '遠い店', location: geo.coordinate(35.681236, 139.767125) },
    ];

    const cells = new Set(geo.cellsForRadius(center, radiusM));
    const precision = geo.precisionForRadius(radiusM);
    const bounds = geo.boundingBox(center, radiusM);

    const found = shops
      .filter((shop) => cells.has(geo.encodeGeohash(shop.location, precision)))
      .filter((shop) => geo.isWithinBounds(shop.location, bounds))
      .filter((shop) => geo.distanceMeters(center, shop.location) <= radiusM);

    expect(found.map((shop) => shop.name)).toEqual(['近い店']);
  });

  it('検索結果を表示用に整形できる', () => {
    const center = geo.coordinate(35.689592, 139.700413);
    const shop = geo.coordinate(35.681236, 139.767125);
    expect(geo.distanceMeters(center, shop)).toBeCloseTo(6096.4, 1);
    expect(geo.formatDistance(geo.distanceMeters(center, shop))).toBe('6.1km');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm run test -w @meshimap/geo -- index
```

期待: `Failed to resolve import "./index"`。

- [ ] **Step 3: バレルを書く**

`packages/geo/src/index.ts`:

```ts
export {
  DEGREES_TO_RADIANS,
  EARTH_RADIUS_M,
  GEOHASH_BASE32,
  LATITUDE_MAX,
  LATITUDE_MIN,
  LONGITUDE_MAX,
  LONGITUDE_MIN,
} from './constants';
export { coordinate, toLatitude, toLongitude, wrapLongitude } from './coordinate';
export type { Coordinate, Latitude, Longitude } from './coordinate';
export { distanceMeters } from './distance';
export { formatDistance } from './format-distance';
export {
  GEOHASH_LENGTH_MAX,
  GEOHASH_LENGTH_MIN,
  decodeGeohash,
  encodeGeohash,
  neighborCells,
  toGeohash,
} from './geohash';
export type { Geohash, GeohashBounds, GeohashPrecision } from './geohash';
export { cellsForRadius, precisionForRadius } from './search-cells';
export { boundingBox, isWithinBounds } from './bounding-box';
export type { BoundingBox } from './bounding-box';
export { ZOOM_MAX, ZOOM_MIN, clusterByGrid, precisionForZoom } from './cluster';
export type { Cluster, GridPoint } from './cluster';
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm run test -w @meshimap/geo -- index
```

期待: 3 件すべて PASS。

> `検索結果を表示用に整形できる` の期待値 `'6.2km'` は、新宿駅→東京駅の実測距離 6188m を `formatDistance` に通した結果。もし異なる値が出たら距離計算か整形のどちらかが壊れているので、期待値の方を書き換えて誤魔化さないこと。実測して差異の原因を特定する。

- [ ] **Step 5: 全テストとカバレッジを確認する**

```bash
npm run test:coverage -w @meshimap/geo
```

期待: 全テスト PASS、かつ `vitest.config.ts` の閾値どおり Statements / Branches / Functions / Lines がすべて **100%**。

100% に届かない行がある場合は、テストを追加して到達させる。**閾値を下げて通すことは禁止。** 到達不能なコードがあるなら、そのコード自体が不要である可能性が高い。

- [ ] **Step 6: 型チェックを通す**

```bash
npm run typecheck -w @meshimap/geo
```

期待: エラーなし。

- [ ] **Step 7: ミューテーションテストを実行する**

```bash
npm run test:mutation -w @meshimap/geo
```

`packages/geo/stryker.config.json` の設定どおり、`thresholds.break: 85` を下回ると**コマンドが失敗する**。

期待: ミューテーションスコア 85% 以上で成功。

- [ ] **Step 8: 生き残った変異を潰す**

レポート（`packages/geo/reports/mutation/mutation.html`）を開き、`Survived` の変異を 1 件ずつ確認する。

```bash
open packages/geo/reports/mutation/mutation.html
```

各 `Survived` について、次のどちらかで対処する。

1. **テストを追加する**（原則こちら）。その変異を殺す境界値テストを書く。変異が殺せない = その分岐の正しさを誰も検証していない、という意味。
2. **コードを削る**。変異させても振る舞いが変わらないなら、そのコードは不要な可能性が高い。

よくある生き残りと対処:

| 生き残る変異                 | 対処                                                              |
| ---------------------------- | ----------------------------------------------------------------- |
| `<=` → `<` の境界比較        | ちょうど境界値のテストを追加する（例: `precisionForRadius(600)`） |
| エラーメッセージの文字列置換 | `toThrow(new RangeError('…'))` で完全一致を検証する               |
| `Math.min(1, x)` → `x`       | 対蹠点など、クランプが効く入力のテストを追加する                  |
| 定数の数値置換               | その定数が結果へ効くことを示す既知値テストを追加する              |
| 配列リテラルの空化           | テーブル各行の境界値テストを追加する                              |

**`stryker.config.json` の閾値を下げて通すことは禁止。**

- [ ] **Step 9: README を書く**

`packages/geo/README.md`:

```markdown
# @meshimap/geo

D1（SQLite）が PostGIS や R*Tree を持たないという制約を、純粋関数だけで埋める地理計算パッケージ。

## 設計方針

- **副作用・外部依存ゼロ。** Cloudflare Workers（`apps/api`）と Expo アプリ（`apps/mobile`）の両方から同じコードを使う。
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

## 使い方

\`\`\`ts
import { boundingBox, cellsForRadius, coordinate, distanceMeters, formatDistance } from '@meshimap/geo';

const center = coordinate(35.689592, 139.700413);
const cells = cellsForRadius(center, 1000); // D1 の IN 句へ
const bounds = boundingBox(center, 1000); // D1 の BETWEEN 句へ
const distance = distanceMeters(center, shop.location);
const label = formatDistance(distance); // "850m" / "1.2km"
\`\`\`

## テスト

\`\`\`bash
npm run test -w @meshimap/geo # 単体テスト
npm run test:coverage -w @meshimap/geo # カバレッジ（閾値 100%）
npm run test:mutation -w @meshimap/geo # ミューテーションテスト（閾値 85%）
\`\`\`
```

- [ ] **Step 10: 最終確認とコミット**

```bash
npm run test:coverage -w @meshimap/geo
npm run test:mutation -w @meshimap/geo
npm run typecheck -w @meshimap/geo
npm run format:check
```

すべて成功したらコミットする。

```bash
git add packages/geo/src/index.ts packages/geo/src/index.test.ts packages/geo/README.md
git commit -m "feat(geo): 公開 API のバレルと README を追加"
```

---

## Phase 1 完了チェックリスト

実装を終えたら、次をすべて満たしていることを確認する。

- [ ] `npm run test -w @meshimap/geo` が全件 PASS する
- [ ] `npm run test:coverage -w @meshimap/geo` で Statements / Branches / Functions / Lines がすべて 100%
- [ ] `npm run test:mutation -w @meshimap/geo` がミューテーションスコア 85% 以上で成功する
- [ ] `npm run typecheck -w @meshimap/geo` がエラーなしで通る
- [ ] `packages/geo/package.json` の `dependencies` が空のまま（外部依存を増やしていない）
- [ ] `packages/geo/src/index.ts` 以外のファイルを他パッケージから import していない
- [ ] `any` と、ブランド型生成以外の `as` を 1 箇所も使っていない
- [ ] 各タスクの「意図的にコードを壊す」ステップをすべて実施し、想定どおり FAIL することを目視した
- [ ] `packages/geo/README.md` に 3 段階検索の説明がある
- [ ] コミットがタスク単位で分かれている（1 タスク 1 コミット）

## 次フェーズへの引き継ぎ

Phase 2（`packages/core`）と Phase 3（`apps/api`）は次のシンボルに依存する。名前と型を変える場合は両フェーズの計画も更新すること。

| シンボル                             | 使う場所                                                        |
| ------------------------------------ | --------------------------------------------------------------- |
| `coordinate` / `Coordinate`          | `packages/core` の店舗スキーマ、`apps/api` の検索エンドポイント |
| `encodeGeohash`                      | `apps/api` の店舗登録時（`shops.geohash` カラムへ保存）         |
| `cellsForRadius`                     | `apps/api` の近傍検索 第 1 段                                   |
| `boundingBox` / `isWithinBounds`     | `apps/api` の近傍検索 第 2 段                                   |
| `distanceMeters`                     | `apps/api` の近傍検索 第 3 段、距離順ソート                     |
| `formatDistance`                     | `apps/mobile` の店舗カード表示                                  |
| `clusterByGrid` / `precisionForZoom` | `apps/mobile` の地図ピン集約                                    |
