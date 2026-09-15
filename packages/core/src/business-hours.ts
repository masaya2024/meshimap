// 曜日ごとの営業時間と臨時休業日の型。D1 の shop_hours / shop_closures に対応する。

import {
  BUSINESS_HOURS_JOINER,
  BUSINESS_HOURS_SEPARATOR,
  MINUTES_PER_DAY,
  REGULAR_HOLIDAY_LABEL,
} from './constants';
import type { DayOfWeek, JstDate } from './jst-clock';
import { formatMinuteOfDay } from './minute-of-day';
import type { MinuteOfDay } from './minute-of-day';

export type BusinessHours = {
  readonly dayOfWeek: DayOfWeek;
  readonly openMinute: MinuteOfDay;
  /** 閉店。1440 を超える値は翌日にまたがることを意味する（1530 = 翌 01:30）。 */
  readonly closeMinute: MinuteOfDay;
  /** 定休日フラグ。行を消さずに残すことで「定休日」と「未登録」を区別する。 */
  readonly isClosed: boolean;
};

export type ShopClosure = {
  readonly date: JstDate;
  readonly reason: string;
};

/** 日跨ぎ営業か。閉店ちょうど 1440（翌 0:00）は当日で閉まる扱いにする。 */
export function isOvernight(hours: BusinessHours): boolean {
  return hours.closeMinute > MINUTES_PER_DAY;
}

/** 指定曜日の営業中の行だけを返す。定休日フラグの行はここで落とす。 */
export function businessHoursOn(
  hours: readonly BusinessHours[],
  dayOfWeek: DayOfWeek,
): readonly BusinessHours[] {
  return hours.filter((entry) => entry.dayOfWeek === dayOfWeek && !entry.isClosed);
}

/** 1 曜日分の営業時間を表示用に整形する。昼夜 2 部は " / " でつなぐ。 */
export function formatBusinessHours(hours: readonly BusinessHours[]): string {
  const dayOfWeeks = new Set(hours.map((entry) => entry.dayOfWeek));
  if (dayOfWeeks.size > 1) {
    throw new RangeError('formatBusinessHours には同一曜日の営業時間だけを渡してください');
  }
  const openEntries = hours.filter((entry) => !entry.isClosed);
  if (openEntries.length === 0) {
    return REGULAR_HOLIDAY_LABEL;
  }
  // 引数の配列を破壊しないよう複製してから並べ替える（lib は ES2022 なので toSorted は使えない）
  return [...openEntries]
    .sort((left, right) => left.openMinute - right.openMinute)
    .map(
      (entry) =>
        `${formatMinuteOfDay(entry.openMinute)}${BUSINESS_HOURS_SEPARATOR}${formatMinuteOfDay(entry.closeMinute)}`,
    )
    .join(BUSINESS_HOURS_JOINER);
}
