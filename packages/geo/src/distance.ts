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
