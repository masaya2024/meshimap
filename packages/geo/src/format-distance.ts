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
