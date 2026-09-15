import { describe, expect, it } from 'vitest';
import { businessHoursOn, formatBusinessHours, isOvernight } from './business-hours';
import type { BusinessHours } from './business-hours';
import type { DayOfWeek } from './jst-clock';
import { toMinuteOfDay } from './minute-of-day';

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

describe('isOvernight', () => {
  it('閉店が 1440 を超えていれば日跨ぎと判定する', () => {
    expect(isOvernight(hours(2, 1080, 1530))).toBe(true);
  });

  it('閉店ちょうど 1440（翌 0:00）は日跨ぎではない', () => {
    expect(isOvernight(hours(2, 1080, 1440))).toBe(false);
  });

  it('当日中に閉まる営業時間は日跨ぎではない', () => {
    expect(isOvernight(hours(2, 1020, 1380))).toBe(false);
  });
});

describe('businessHoursOn', () => {
  const week: readonly BusinessHours[] = [
    hours(2, 690, 840),
    hours(2, 1020, 1380),
    hours(3, 0, 0, true),
    hours(4, 1080, 1530),
  ];

  it('指定した曜日の行だけを返す', () => {
    expect(businessHoursOn(week, 4)).toEqual([hours(4, 1080, 1530)]);
  });

  it('同じ曜日に複数の営業帯があればすべて返す', () => {
    expect(businessHoursOn(week, 2)).toHaveLength(2);
  });

  it('定休日フラグが立った行は除外する', () => {
    expect(businessHoursOn(week, 3)).toEqual([]);
  });

  it('行が無い曜日は空配列を返す', () => {
    expect(businessHoursOn(week, 0)).toEqual([]);
  });

  it('元の配列を書き換えない', () => {
    const before = [...week];
    businessHoursOn(week, 2);
    expect(week).toEqual(before);
  });
});

describe('formatBusinessHours', () => {
  it('日跨ぎ営業を "18:00 - 翌 1:30" と表示する', () => {
    expect(formatBusinessHours([hours(2, 1080, 1530)])).toBe('18:00 - 翌 1:30');
  });

  it('深夜 2 時閉店を "22:30 - 翌 2:00" と表示する', () => {
    expect(formatBusinessHours([hours(2, 1350, 1560)])).toBe('22:30 - 翌 2:00');
  });

  it('昼夜 2 部営業をスラッシュ区切りで表示する', () => {
    expect(formatBusinessHours([hours(2, 690, 840), hours(2, 1020, 1380)])).toBe(
      '11:30 - 14:00 / 17:00 - 23:00',
    );
  });

  it('入力順が逆でも開店時刻の昇順に並べ替えて表示する', () => {
    expect(formatBusinessHours([hours(2, 1020, 1380), hours(2, 690, 840)])).toBe(
      '11:30 - 14:00 / 17:00 - 23:00',
    );
  });

  it('元の配列を並べ替えない', () => {
    const input = [hours(2, 1020, 1380), hours(2, 690, 840)];
    formatBusinessHours(input);
    expect(input[0]?.openMinute).toBe(1020);
  });

  it('定休日フラグだけの曜日を "定休日" と表示する', () => {
    expect(formatBusinessHours([hours(3, 0, 0, true)])).toBe('定休日');
  });

  it('行が 1 つも無い曜日を "定休日" と表示する', () => {
    expect(formatBusinessHours([])).toBe('定休日');
  });

  it('24 時間営業を "0:00 - 翌 0:00" と表示する', () => {
    expect(formatBusinessHours([hours(2, 0, 1440)])).toBe('0:00 - 翌 0:00');
  });

  it('複数曜日を混ぜて渡すと拒否する', () => {
    expect(() => formatBusinessHours([hours(1, 600, 1200), hours(2, 600, 1200)])).toThrow(
      new RangeError('formatBusinessHours には同一曜日の営業時間だけを渡してください'),
    );
  });
});
