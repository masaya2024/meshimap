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

const LONGITUDE_RANGE = LONGITUDE_MAX - LONGITUDE_MIN;

/**
 * 経度を -180 以上 180 未満の範囲へ折り返す。
 * 日付変更線を跨ぐ計算（近傍セル・境界ボックス）で、範囲外へはみ出した値を正規化する。
 *
 * 先に -180 分ずらしてから剰余を取る書き方だと、加算と減算で丸めが発生し
 * 範囲内の値まで値が変わってしまう（実測: 179.999 → 179.99900000000002）。
 * 剰余を先に取り、範囲を外れたときだけ 1 周分を足し引きすることで、
 * 範囲内の値をビット単位でそのまま通す。
 */
export function wrapLongitude(value: number): Longitude {
  let wrapped = value % LONGITUDE_RANGE;
  if (wrapped >= LONGITUDE_MAX) {
    wrapped -= LONGITUDE_RANGE;
  } else if (wrapped < LONGITUDE_MIN) {
    wrapped += LONGITUDE_RANGE;
  }
  return toLongitude(wrapped);
}
