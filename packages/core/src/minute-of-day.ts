// 営業時間を「0 時からの分」で表す型。1080 = 18:00、1530 = 翌 01:30。
// 分の整数で持つことで、日跨ぎ営業の判定が単純な数値比較になる。

import {
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  MINUTE_OF_DAY_MAX,
  MINUTE_OF_DAY_MIN,
  NEXT_DAY_PREFIX,
} from './constants';

declare const minuteOfDayBrand: unique symbol;
export type MinuteOfDay = number & { readonly [minuteOfDayBrand]: true };

/** 生の数値を検証して MinuteOfDay にする。D1 から読んだ値の入口。 */
export function toMinuteOfDay(value: number): MinuteOfDay {
  if (!Number.isInteger(value)) {
    throw new RangeError(`0 時からの分は整数である必要があります: ${value}`);
  }
  if (value < MINUTE_OF_DAY_MIN || value > MINUTE_OF_DAY_MAX) {
    throw new RangeError(
      `0 時からの分は ${MINUTE_OF_DAY_MIN} 〜 ${MINUTE_OF_DAY_MAX} の範囲である必要があります: ${value}`,
    );
  }
  // ブランド型の生成点
  return value as MinuteOfDay;
}

/** 「時:分」から組み立てる。時は 24 以上も許し、25:30 のような翌日表記を受け付ける。 */
export function minuteOfDay(hour: number, minute: number): MinuteOfDay {
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new RangeError(`時と分は整数である必要があります: ${hour}:${minute}`);
  }
  if (minute < 0 || minute >= MINUTES_PER_HOUR) {
    throw new RangeError(`分は 0 〜 ${MINUTES_PER_HOUR - 1} の範囲である必要があります: ${minute}`);
  }
  return toMinuteOfDay(hour * MINUTES_PER_HOUR + minute);
}

/** 表示用に整形する。1440 以上は「翌 」を付けて 0 時起点に戻す。 */
export function formatMinuteOfDay(value: MinuteOfDay): string {
  const dayOffset = Math.floor(value / MINUTES_PER_DAY);
  const withinDay = value - dayOffset * MINUTES_PER_DAY;
  const hour = Math.floor(withinDay / MINUTES_PER_HOUR);
  const minute = withinDay - hour * MINUTES_PER_HOUR;
  // 時は 0 詰めしない（18:00 / 9:00）。分は必ず 2 桁にする
  const time = `${hour}:${String(minute).padStart(2, '0')}`;
  return dayOffset === 0 ? time : `${NEXT_DAY_PREFIX}${time}`;
}
