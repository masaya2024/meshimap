// 「いま営業中か」の判定。当日分と、前日から続く日跨ぎ分の両方を見る必要がある。

import { CLOSING_SOON_THRESHOLD_MINUTES, MINUTES_PER_DAY } from './constants';
import { businessHoursOn } from './business-hours';
import type { BusinessHours, ShopClosure } from './business-hours';
import { addJstDays, previousDayOfWeek, toJstClock } from './jst-clock';
import type { JstDate } from './jst-clock';

export type OpenStatus = 'open' | 'closing-soon' | 'closed' | 'regular-holiday';

function hasClosure(closures: readonly ShopClosure[], date: JstDate): boolean {
  return closures.some((closure) => closure.date === date);
}

/** 閉店までの残り分。営業時間外なら null。昼夜 2 部では短い方（いまいる部）を返す。 */
export function minutesUntilClose(
  hours: readonly BusinessHours[],
  closures: readonly ShopClosure[],
  now: Date,
): number | null {
  const clock = toJstClock(now);
  let shortest: number | null = null;

  // 当日分。開店ちょうどは営業中、閉店ちょうどは営業時間外
  if (!hasClosure(closures, clock.date)) {
    for (const entry of businessHoursOn(hours, clock.dayOfWeek)) {
      if (clock.minuteOfDay >= entry.openMinute && clock.minuteOfDay < entry.closeMinute) {
        const remaining = entry.closeMinute - clock.minuteOfDay;
        // 比較演算子で書くと <= に変えても結果が同じ等価変異が残るため Math.min を使う
        shortest = shortest === null ? remaining : Math.min(shortest, remaining);
      }
    }
  }

  // 前日から続く日跨ぎ分。臨時休業の判定も前日の日付で行う
  if (!hasClosure(closures, addJstDays(clock.date, -1))) {
    // shifted は必ず 1440 以上なので、閉店が 1440 以下の当日で閉まる行は自然に外れる。
    // isOvernight での事前判定は結果を変えないため置かない
    const shifted = clock.minuteOfDay + MINUTES_PER_DAY;
    for (const entry of businessHoursOn(hours, previousDayOfWeek(clock.dayOfWeek))) {
      if (shifted >= entry.openMinute && shifted < entry.closeMinute) {
        const remaining = entry.closeMinute - shifted;
        // 比較演算子で書くと <= に変えても結果が同じ等価変異が残るため Math.min を使う
        shortest = shortest === null ? remaining : Math.min(shortest, remaining);
      }
    }
  }

  return shortest;
}

export function isCurrentlyOpen(
  hours: readonly BusinessHours[],
  closures: readonly ShopClosure[],
  now: Date,
): boolean {
  return minutesUntilClose(hours, closures, now) !== null;
}

/** 表示用のステータス。中休みは closed、営業日が無い曜日は regular-holiday と区別する。 */
export function getOpenStatus(
  hours: readonly BusinessHours[],
  closures: readonly ShopClosure[],
  now: Date,
): OpenStatus {
  const remaining = minutesUntilClose(hours, closures, now);
  if (remaining !== null) {
    return remaining <= CLOSING_SOON_THRESHOLD_MINUTES ? 'closing-soon' : 'open';
  }
  const clock = toJstClock(now);
  // 臨時休業は「今日はやっていない」であって定休日ではない
  if (hasClosure(closures, clock.date)) {
    return 'closed';
  }
  return businessHoursOn(hours, clock.dayOfWeek).length === 0 ? 'regular-holiday' : 'closed';
}
