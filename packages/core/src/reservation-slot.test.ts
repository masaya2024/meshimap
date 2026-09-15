import { describe, expect, it } from 'vitest';
import type { BusinessHours } from './business-hours';
import type { DayOfWeek } from './jst-clock';
import { toJstDate } from './jst-clock';
import { toMinuteOfDay } from './minute-of-day';
import { assertSeatSettings, generateSlots } from './reservation-slot';
import type { ReservationSlot, SeatSettings } from './reservation-slot';

function hours(
  dayOfWeek: DayOfWeek,
  openMinute: number,
  closeMinute: number,
  isClosed = false,
): BusinessHours {
  return {
    dayOfWeek,
    openMinute: toMinuteOfDay(openMinute),
    closeMinute: toMinuteOfDay(closeMinute),
    isClosed,
  };
}

function seatSettings(overrides: Partial<SeatSettings> = {}): SeatSettings {
  return {
    capacity: 10,
    slotMinutes: 90,
    maxParallel: 3,
    acceptsReservation: true,
    ...overrides,
  };
}

/** 検証を読みやすくするため [開始, 終了] の組に落とす。 */
function toPairs(slots: readonly ReservationSlot[]): readonly (readonly [number, number])[] {
  return slots.map((slot) => [slot.startMinute, slot.endMinute] as const);
}

/** 2026-09-15 は火曜（dayOfWeek = 2）。 */
const TUESDAY = toJstDate('2026-09-15');

describe('assertSeatSettings', () => {
  it('既定の設定を受け入れる', () => {
    expect(() => assertSeatSettings(seatSettings())).not.toThrow();
  });

  it('枠の長さが下限 15 分未満なら拒否する', () => {
    expect(() => assertSeatSettings(seatSettings({ slotMinutes: 14 }))).toThrow(
      new RangeError('予約枠の長さは 15 〜 240 分の整数である必要があります: 14'),
    );
  });

  it('枠の長さが上限 240 分を超えたら拒否する', () => {
    expect(() => assertSeatSettings(seatSettings({ slotMinutes: 241 }))).toThrow(
      new RangeError('予約枠の長さは 15 〜 240 分の整数である必要があります: 241'),
    );
  });

  it('枠の長さの小数を拒否する', () => {
    expect(() => assertSeatSettings(seatSettings({ slotMinutes: 30.5 }))).toThrow(
      new RangeError('予約枠の長さは 15 〜 240 分の整数である必要があります: 30.5'),
    );
  });

  it('席数 0 を拒否する', () => {
    expect(() => assertSeatSettings(seatSettings({ capacity: 0 }))).toThrow(
      new RangeError('席数は 1 〜 500 の整数である必要があります: 0'),
    );
  });

  it('席数が上限 500 を超えたら拒否する', () => {
    expect(() => assertSeatSettings(seatSettings({ capacity: 501 }))).toThrow(
      new RangeError('席数は 1 〜 500 の整数である必要があります: 501'),
    );
  });

  it('同時受付数 0 を拒否する', () => {
    expect(() => assertSeatSettings(seatSettings({ maxParallel: 0 }))).toThrow(
      new RangeError('同時受付数は 1 〜 100 の整数である必要があります: 0'),
    );
  });

  it('同時受付数が上限 100 を超えたら拒否する', () => {
    expect(() => assertSeatSettings(seatSettings({ maxParallel: 101 }))).toThrow(
      new RangeError('同時受付数は 1 〜 100 の整数である必要があります: 101'),
    );
  });
});

describe('generateSlots', () => {
  it('営業時間を割り切れる場合は最後の枠が閉店ちょうどで終わる', () => {
    expect(toPairs(generateSlots([hours(2, 1080, 1530)], seatSettings(), TUESDAY))).toEqual([
      [1080, 1170],
      [1170, 1260],
      [1260, 1350],
      [1350, 1440],
      [1440, 1530],
    ]);
  });

  it('割り切れない端数は切り捨てる（閉店をはみ出す枠を作らない）', () => {
    expect(toPairs(generateSlots([hours(2, 1080, 1500)], seatSettings(), TUESDAY))).toEqual([
      [1080, 1170],
      [1170, 1260],
      [1260, 1350],
      [1350, 1440],
    ]);
  });

  it('生成した枠がすべて営業時間内に収まる', () => {
    const slots = generateSlots([hours(2, 1080, 1500)], seatSettings(), TUESDAY);
    for (const slot of slots) {
      expect(slot.startMinute).toBeGreaterThanOrEqual(1080);
      expect(slot.endMinute).toBeLessThanOrEqual(1500);
    }
  });

  it('昼夜 2 部営業では両方の営業帯から枠を作り開始時刻の昇順で返す', () => {
    const twoPart = [hours(2, 1020, 1380), hours(2, 690, 840)];
    expect(toPairs(generateSlots(twoPart, seatSettings({ slotMinutes: 60 }), TUESDAY))).toEqual([
      [690, 750],
      [750, 810],
      [1020, 1080],
      [1080, 1140],
      [1140, 1200],
      [1200, 1260],
      [1260, 1320],
      [1320, 1380],
    ]);
  });

  it('定休日フラグの曜日は空配列を返す', () => {
    expect(generateSlots([hours(2, 0, 0, true)], seatSettings(), TUESDAY)).toEqual([]);
  });

  it('その曜日の営業時間が無ければ空配列を返す', () => {
    expect(generateSlots([hours(1, 600, 1200)], seatSettings(), TUESDAY)).toEqual([]);
  });

  it('枠の長さが営業時間より長ければ空配列を返す', () => {
    expect(
      generateSlots([hours(2, 600, 660)], seatSettings({ slotMinutes: 120 }), TUESDAY),
    ).toEqual([]);
  });

  it('営業時間と枠の長さが同じなら枠は 1 つだけできる', () => {
    expect(
      toPairs(generateSlots([hours(2, 600, 660)], seatSettings({ slotMinutes: 60 }), TUESDAY)),
    ).toEqual([[600, 660]]);
  });

  it('受付停止中でも枠自体は生成する（受付可否は canReserve の責務）', () => {
    expect(
      generateSlots([hours(2, 1080, 1530)], seatSettings({ acceptsReservation: false }), TUESDAY),
    ).toHaveLength(5);
  });

  it('席設定が不正なら枠を作る前に拒否する', () => {
    expect(() =>
      generateSlots([hours(2, 1080, 1530)], seatSettings({ slotMinutes: 0 }), TUESDAY),
    ).toThrow(new RangeError('予約枠の長さは 15 〜 240 分の整数である必要があります: 0'));
  });

  it('元の営業時間配列を並べ替えない', () => {
    const input = [hours(2, 1020, 1380), hours(2, 690, 840)];
    generateSlots(input, seatSettings({ slotMinutes: 60 }), TUESDAY);
    expect(input[0]?.openMinute).toBe(1020);
  });
});

describe('assertSeatSettings（境界ちょうどは受け入れる）', () => {
  it('枠の長さは下限 15 分と上限 240 分を受け入れる', () => {
    expect(() => assertSeatSettings(seatSettings({ slotMinutes: 15 }))).not.toThrow();
    expect(() => assertSeatSettings(seatSettings({ slotMinutes: 240 }))).not.toThrow();
  });

  it('席数は下限 1 と上限 500 を受け入れる', () => {
    expect(() => assertSeatSettings(seatSettings({ capacity: 1 }))).not.toThrow();
    expect(() => assertSeatSettings(seatSettings({ capacity: 500 }))).not.toThrow();
  });

  it('同時受付数は下限 1 と上限 100 を受け入れる', () => {
    expect(() => assertSeatSettings(seatSettings({ maxParallel: 1 }))).not.toThrow();
    expect(() => assertSeatSettings(seatSettings({ maxParallel: 100 }))).not.toThrow();
  });
});
