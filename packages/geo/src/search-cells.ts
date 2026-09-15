import type { Coordinate } from './coordinate';
import { encodeGeohash, neighborCells } from './geohash';
import type { Geohash, GeohashPrecision } from './geohash';

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

/**
 * 中心と半径から、第 1 段の SQL に渡すセル一覧を返す。
 * 先頭は必ず中心セル、以降は時計回りの 8 近傍。
 *
 * これは 3 段階検索の第 1 段。ここで候補を粗く絞り、
 * 第 2 段の境界ボックス（`boundingBox` / `isWithinBounds`）と
 * 第 3 段の Haversine（`distanceMeters`）で正確に仕上げる。
 *
 * 返すセルは半径に応じて精度 3〜7 と長さが変わるが、`shops.geohash` は
 * 精度 7 固定で保存される。したがって SQL は等値（`IN`）ではなく
 * 前方一致でなければならず、その前方一致は範囲比較で書く:
 *
 *     WHERE (geohash >= :cell AND geohash < :cell || '{') OR …（9 セルぶん）
 *
 * `GLOB ?` でも索引は効くが、バインド値が NULL や先頭ワイルドカードだと
 * 全表走査へ落ちる。範囲比較なら値に関係なく必ず索引を使うのでこちらにする。
 * 上限の `{`（U+007A の `z` の次）は、geohash のアルファベットの最大文字が
 * `z` であることに依る。実測の根拠は packages/geo/README.md
 * 「3 段階の近傍検索」にある。
 */
export function cellsForRadius(center: Coordinate, radiusM: number): readonly Geohash[] {
  const precision = precisionForRadius(radiusM);
  const centerCell = encodeGeohash(center, precision);
  return [centerCell, ...neighborCells(centerCell)];
}
