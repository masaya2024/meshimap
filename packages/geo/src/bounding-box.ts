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
  // includesPole が false なので cos は 0 にならない。
  // このとき緯度差 < 90 - |中心緯度| が保証され、経度差は最大でも約 90 度
  // （赤道で上限、極へ近づくほど 180/π ≈ 57.3 度へ収束する）。
  // 180 度を超えないので、ここで全経度へ広げる判定は不要
  const longitudeDeltaDeg = latitudeDeltaDeg / Math.cos(center.latitude * DEGREES_TO_RADIANS);

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
