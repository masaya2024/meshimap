// JST（UTC+9）での日付・曜日・時刻を、実行環境のタイムゾーンに依存せずに求める。
// Date のローカル時刻メソッド（getHours 等）は TZ 環境変数で結果が変わるため一切使わず、
// エポックミリ秒に +9 時間してから getUTC* で読む。

import {
  DAYS_PER_WEEK,
  DAY_OF_WEEK_MAX,
  DAY_OF_WEEK_MIN,
  JST_OFFSET_MINUTES,
  MILLISECONDS_PER_DAY,
  MILLISECONDS_PER_MINUTE,
  MINUTES_PER_HOUR,
} from './constants';
import { toMinuteOfDay } from './minute-of-day';
import type { MinuteOfDay } from './minute-of-day';

declare const jstDateBrand: unique symbol;
/** JST の暦日（YYYY-MM-DD）。タイムゾーンを持たない「日付」そのもの。 */
export type JstDate = string & { readonly [jstDateBrand]: true };

/** 0 = 日曜 〜 6 = 土曜。D1 の shop_hours.day_of_week と同じ並び。 */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type JstClock = {
  readonly date: JstDate;
  readonly dayOfWeek: DayOfWeek;
  readonly minuteOfDay: MinuteOfDay;
};

const JST_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Date を UTC のまま YYYY-MM-DD にする。年は 4 桁に 0 詰めする。 */
function formatUtcDate(value: Date): string {
  const year = String(value.getUTCFullYear()).padStart(4, '0');
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 文字列を JstDate にする。new Date は 2026-02-30 を 3/2 に繰り上げるので往復比較で弾く。 */
export function toJstDate(value: string): JstDate {
  if (!JST_DATE_PATTERN.test(value)) {
    throw new RangeError(`日付は YYYY-MM-DD 形式である必要があります: "${value}"`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || formatUtcDate(parsed) !== value) {
    throw new RangeError(`存在しない日付です: "${value}"`);
  }
  // ブランド型の生成点
  return value as JstDate;
}

export function toDayOfWeek(value: number): DayOfWeek {
  if (!Number.isInteger(value) || value < DAY_OF_WEEK_MIN || value > DAY_OF_WEEK_MAX) {
    throw new RangeError(
      `曜日は ${DAY_OF_WEEK_MIN} 〜 ${DAY_OF_WEEK_MAX} の整数である必要があります: ${value}`,
    );
  }
  // ブランド型ではなくリテラル union への絞り込み。検証済みなのでここだけ as を使う
  return value as DayOfWeek;
}

export function dayOfWeekOf(date: JstDate): DayOfWeek {
  return toDayOfWeek(new Date(`${date}T00:00:00Z`).getUTCDay());
}

/** 日付の加減算。UTC 深夜起点で計算するので夏時間の影響を受けない。 */
export function addJstDays(date: JstDate, days: number): JstDate {
  if (!Number.isInteger(days)) {
    throw new RangeError(`日数は整数である必要があります: ${days}`);
  }
  const moved = new Date(new Date(`${date}T00:00:00Z`).getTime() + days * MILLISECONDS_PER_DAY);
  return toJstDate(formatUtcDate(moved));
}

/** 前日の曜日。日跨ぎ営業の判定で「前日の営業時間」を引くために使う。 */
export function previousDayOfWeek(value: DayOfWeek): DayOfWeek {
  return toDayOfWeek((value + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK);
}

/** 現在時刻（UTC 基準の Date）を JST の日付・曜日・分に変換する。 */
export function toJstClock(now: Date): JstClock {
  if (Number.isNaN(now.getTime())) {
    throw new RangeError('現在時刻に Invalid Date は渡せません');
  }
  // +9 時間ずらしてから getUTC* で読むと、実行環境の TZ に左右されない
  const shifted = new Date(now.getTime() + JST_OFFSET_MINUTES * MILLISECONDS_PER_MINUTE);
  return {
    date: toJstDate(formatUtcDate(shifted)),
    dayOfWeek: toDayOfWeek(shifted.getUTCDay()),
    minuteOfDay: toMinuteOfDay(shifted.getUTCHours() * MINUTES_PER_HOUR + shifted.getUTCMinutes()),
  };
}
