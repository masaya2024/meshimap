import {
  GEOHASH_BASE32,
  LATITUDE_MAX,
  LATITUDE_MIN,
  LONGITUDE_MAX,
  LONGITUDE_MIN,
} from './constants';
import { coordinate, wrapLongitude } from './coordinate';
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
 *
 * 重複除去は不要。geohash の格子は最小の precision 1 でも経度 8 列・緯度 4 行あり、
 * 東西へ 1 列ずらしても自セルへは戻らない。南北の折り返しは上の緯度ガードで除外される。
 */
export function neighborCells(hash: Geohash): readonly Geohash[] {
  const bounds = decodeGeohash(hash);
  const latitudeStep = bounds.latitudeMax - bounds.latitudeMin;
  const longitudeStep = bounds.longitudeMax - bounds.longitudeMin;
  const precision = hash.length as GeohashPrecision;

  const neighbors: Geohash[] = [];

  for (const [latitudeOffset, longitudeOffset] of NEIGHBOR_OFFSETS) {
    const latitude = bounds.center.latitude + latitudeOffset * latitudeStep;
    // 近傍の中心は格子の中心（-90 + (k + 0.5) * ステップ）にしか乗らないため、
    // ±90 ちょうどには決してならない。よって等号の有無は結果を変えない
    if (latitude > LATITUDE_MAX || latitude < LATITUDE_MIN) {
      continue;
    }
    const longitude = wrapLongitude(bounds.center.longitude + longitudeOffset * longitudeStep);
    neighbors.push(encodeGeohash(coordinate(latitude, longitude), precision));
  }

  return neighbors;
}
