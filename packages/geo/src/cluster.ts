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
