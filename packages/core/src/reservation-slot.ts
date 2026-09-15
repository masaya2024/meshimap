// 営業時間から予約枠を切り出す。D1 の seat_settings（capacity / slot_minutes / max_parallel）に対応。

import {
  MAX_PARALLEL_MAX,
  MAX_PARALLEL_MIN,
  SEAT_CAPACITY_MAX,
  SEAT_CAPACITY_MIN,
  SLOT_MINUTES_MAX,
  SLOT_MINUTES_MIN,
} from './constants';
import { businessHoursOn } from './business-hours';
import type { BusinessHours } from './business-hours';
import { dayOfWeekOf } from './jst-clock';
import type { JstDate } from './jst-clock';
import { toMinuteOfDay } from './minute-of-day';
import type { MinuteOfDay } from './minute-of-day';

export type SeatSettings = {
  readonly capacity: number;
  readonly slotMinutes: number;
  /** 同一枠で受け付ける予約「件数」の上限。席数とは別枠の制限。 */
  readonly maxParallel: number;
  readonly acceptsReservation: boolean;
};

export type ReservationSlot = {
  readonly startMinute: MinuteOfDay;
  readonly endMinute: MinuteOfDay;
};

/** 席設定の検証。枠生成と予約可否の両方から呼ぶので独立した関数にする。 */
export function assertSeatSettings(seatSettings: SeatSettings): void {
  if (
    !Number.isInteger(seatSettings.slotMinutes) ||
    seatSettings.slotMinutes < SLOT_MINUTES_MIN ||
    seatSettings.slotMinutes > SLOT_MINUTES_MAX
  ) {
    throw new RangeError(
      `予約枠の長さは ${SLOT_MINUTES_MIN} 〜 ${SLOT_MINUTES_MAX} 分の整数である必要があります: ${seatSettings.slotMinutes}`,
    );
  }
  if (
    !Number.isInteger(seatSettings.capacity) ||
    seatSettings.capacity < SEAT_CAPACITY_MIN ||
    seatSettings.capacity > SEAT_CAPACITY_MAX
  ) {
    throw new RangeError(
      `席数は ${SEAT_CAPACITY_MIN} 〜 ${SEAT_CAPACITY_MAX} の整数である必要があります: ${seatSettings.capacity}`,
    );
  }
  if (
    !Number.isInteger(seatSettings.maxParallel) ||
    seatSettings.maxParallel < MAX_PARALLEL_MIN ||
    seatSettings.maxParallel > MAX_PARALLEL_MAX
  ) {
    throw new RangeError(
      `同時受付数は ${MAX_PARALLEL_MIN} 〜 ${MAX_PARALLEL_MAX} の整数である必要があります: ${seatSettings.maxParallel}`,
    );
  }
}

/**
 * 指定日の予約枠を開店時刻から順に切り出す。閉店をまたぐ端数は捨てる。
 * acceptsReservation は「枠が存在するか」とは別の話なので、ここでは見ない（canReserve の責務）。
 */
export function generateSlots(
  hours: readonly BusinessHours[],
  seatSettings: SeatSettings,
  date: JstDate,
): readonly ReservationSlot[] {
  assertSeatSettings(seatSettings);
  const slots: ReservationSlot[] = [];
  for (const entry of businessHoursOn(hours, dayOfWeekOf(date))) {
    // start は加算していくので MinuteOfDay ではなく number として持つ
    for (
      let start: number = entry.openMinute;
      start + seatSettings.slotMinutes <= entry.closeMinute;
      start += seatSettings.slotMinutes
    ) {
      slots.push({
        startMinute: toMinuteOfDay(start),
        endMinute: toMinuteOfDay(start + seatSettings.slotMinutes),
      });
    }
  }
  // 昼夜 2 部が逆順で登録されていても開始時刻の昇順で返す
  return [...slots].sort((left, right) => left.startMinute - right.startMinute);
}
