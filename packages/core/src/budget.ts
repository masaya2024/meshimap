// 予算帯の表示。Intl / toLocaleString は React Native（Hermes）で挙動が揺れるので使わない。

import { BUDGET_YEN_MAX, BUDGET_YEN_MIN } from './constants';

const CURRENCY_PREFIX = '¥';
/** 予算が未登録のときの表示。全角ダッシュで桁区切りと紛れないようにする。 */
export const BUDGET_UNSET_LABEL = '－';
const BUDGET_RANGE_SEPARATOR = ' 〜 ';
const BUDGET_FROM_SUFFIX = ' 〜';
const BUDGET_UP_TO_PREFIX = '〜 ';
/** 3 桁ごとの区切り位置（数字が続く境界）にマッチする。 */
const THOUSANDS_SEPARATOR_PATTERN = /\B(?=(\d{3})+(?!\d))/g;

export function formatYen(value: number): string {
  if (!Number.isInteger(value) || value < BUDGET_YEN_MIN || value > BUDGET_YEN_MAX) {
    throw new RangeError(
      `予算は ${BUDGET_YEN_MIN} 〜 ${BUDGET_YEN_MAX} 円の整数である必要があります: ${value}`,
    );
  }
  return `${CURRENCY_PREFIX}${String(value).replace(THOUSANDS_SEPARATOR_PATTERN, ',')}`;
}

/** 下限・上限のどちらが欠けても読める表示にする。 */
export function formatBudgetRange(minYen: number | null, maxYen: number | null): string {
  if (minYen === null) {
    return maxYen === null ? BUDGET_UNSET_LABEL : `${BUDGET_UP_TO_PREFIX}${formatYen(maxYen)}`;
  }
  if (maxYen === null) {
    return `${formatYen(minYen)}${BUDGET_FROM_SUFFIX}`;
  }
  if (minYen > maxYen) {
    throw new RangeError(`予算の下限は上限以下である必要があります: ${minYen} > ${maxYen}`);
  }
  // 下限と上限が同じなら 1 つだけ出す
  return minYen === maxYen
    ? formatYen(minYen)
    : `${formatYen(minYen)}${BUDGET_RANGE_SEPARATOR}${formatYen(maxYen)}`;
}
