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
