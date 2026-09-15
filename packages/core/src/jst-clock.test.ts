import { describe, expect, it, vi } from 'vitest';
import {
  addJstDays,
  dayOfWeekOf,
  previousDayOfWeek,
  toDayOfWeek,
  toJstClock,
  toJstDate,
} from './jst-clock';

describe('toJstDate', () => {
  it('YYYY-MM-DD 形式の実在する日付を受け入れる', () => {
    expect(toJstDate('2026-09-15')).toBe('2026-09-15');
  });

  it('閏年の 2 月 29 日を受け入れる', () => {
    expect(toJstDate('2024-02-29')).toBe('2024-02-29');
  });

  it('桁数が足りない形式を拒否する', () => {
    expect(() => toJstDate('2026-9-15')).toThrow(
      new RangeError('日付は YYYY-MM-DD 形式である必要があります: "2026-9-15"'),
    );
  });

  it('区切り文字が違う形式を拒否する', () => {
    expect(() => toJstDate('2026/09/15')).toThrow(
      new RangeError('日付は YYYY-MM-DD 形式である必要があります: "2026/09/15"'),
    );
  });

  it('時刻付きの ISO 文字列を拒否する', () => {
    expect(() => toJstDate('2026-09-15T00:00:00Z')).toThrow(
      new RangeError('日付は YYYY-MM-DD 形式である必要があります: "2026-09-15T00:00:00Z"'),
    );
  });

  it('存在しない 2 月 30 日を拒否する（Date の自動繰り上がりを検知する）', () => {
    expect(() => toJstDate('2026-02-30')).toThrow(
      new RangeError('存在しない日付です: "2026-02-30"'),
    );
  });

  it('平年の 2 月 29 日を拒否する', () => {
    expect(() => toJstDate('2026-02-29')).toThrow(
      new RangeError('存在しない日付です: "2026-02-29"'),
    );
  });

  it('9 月 31 日を拒否する', () => {
    expect(() => toJstDate('2026-09-31')).toThrow(
      new RangeError('存在しない日付です: "2026-09-31"'),
    );
  });

  it('13 月を拒否する', () => {
    expect(() => toJstDate('2026-13-01')).toThrow(
      new RangeError('存在しない日付です: "2026-13-01"'),
    );
  });

  it('0 月を拒否する', () => {
    expect(() => toJstDate('2026-00-10')).toThrow(
      new RangeError('存在しない日付です: "2026-00-10"'),
    );
  });
});

describe('toDayOfWeek', () => {
  it('下限 0（日曜）を受け入れる', () => {
    expect(toDayOfWeek(0)).toBe(0);
  });

  it('上限 6（土曜）を受け入れる', () => {
    expect(toDayOfWeek(6)).toBe(6);
  });

  it('7 を拒否する', () => {
    expect(() => toDayOfWeek(7)).toThrow(
      new RangeError('曜日は 0 〜 6 の整数である必要があります: 7'),
    );
  });

  it('負の値を拒否する', () => {
    expect(() => toDayOfWeek(-1)).toThrow(
      new RangeError('曜日は 0 〜 6 の整数である必要があります: -1'),
    );
  });

  it('小数を拒否する', () => {
    expect(() => toDayOfWeek(1.5)).toThrow(
      new RangeError('曜日は 0 〜 6 の整数である必要があります: 1.5'),
    );
  });
});

describe('dayOfWeekOf', () => {
  it('2026-09-13 は日曜（0）である', () => {
    expect(dayOfWeekOf(toJstDate('2026-09-13'))).toBe(0);
  });

  it('2026-09-15 は火曜（2）である', () => {
    expect(dayOfWeekOf(toJstDate('2026-09-15'))).toBe(2);
  });

  it('2026-09-19 は土曜（6）である', () => {
    expect(dayOfWeekOf(toJstDate('2026-09-19'))).toBe(6);
  });
});

describe('addJstDays', () => {
  it('前日へ戻せる', () => {
    expect(addJstDays(toJstDate('2026-09-15'), -1)).toBe('2026-09-14');
  });

  it('月初から前日へ戻ると前月末になる', () => {
    expect(addJstDays(toJstDate('2026-10-01'), -1)).toBe('2026-09-30');
  });

  it('平年の 3 月 1 日から前日へ戻ると 2 月 28 日になる', () => {
    expect(addJstDays(toJstDate('2026-03-01'), -1)).toBe('2026-02-28');
  });

  it('閏年の 3 月 1 日から前日へ戻ると 2 月 29 日になる', () => {
    expect(addJstDays(toJstDate('2024-03-01'), -1)).toBe('2024-02-29');
  });

  it('年始から前日へ戻ると前年末になる', () => {
    expect(addJstDays(toJstDate('2026-01-01'), -1)).toBe('2025-12-31');
  });

  it('年末から翌日へ進むと翌年始になる', () => {
    expect(addJstDays(toJstDate('2026-12-31'), 1)).toBe('2027-01-01');
  });

  it('0 日移動は同じ日付を返す', () => {
    expect(addJstDays(toJstDate('2026-09-15'), 0)).toBe('2026-09-15');
  });

  it('小数の日数を拒否する', () => {
    expect(() => addJstDays(toJstDate('2026-09-15'), 0.5)).toThrow(
      new RangeError('日数は整数である必要があります: 0.5'),
    );
  });
});

describe('previousDayOfWeek', () => {
  it('火曜（2）の前日は月曜（1）である', () => {
    expect(previousDayOfWeek(2)).toBe(1);
  });

  it('日曜（0）の前日は土曜（6）へ巻き戻る', () => {
    expect(previousDayOfWeek(0)).toBe(6);
  });
});

describe('toJstClock', () => {
  it('UTC 00:00 は JST 09:00 になる', () => {
    expect(toJstClock(new Date('2026-09-15T00:00:00Z'))).toEqual({
      date: '2026-09-15',
      dayOfWeek: 2,
      minuteOfDay: 540,
    });
  });

  it('UTC 14:59:59 はまだ JST の同日 23:59 である', () => {
    expect(toJstClock(new Date('2026-09-15T14:59:59Z'))).toEqual({
      date: '2026-09-15',
      dayOfWeek: 2,
      minuteOfDay: 1439,
    });
  });

  it('UTC 15:00 で JST の日付が翌日 00:00 へ変わる', () => {
    expect(toJstClock(new Date('2026-09-15T15:00:00Z'))).toEqual({
      date: '2026-09-16',
      dayOfWeek: 3,
      minuteOfDay: 0,
    });
  });

  it('秒は切り捨てて分までを返す', () => {
    expect(toJstClock(new Date('2026-09-15T00:00:59Z')).minuteOfDay).toBe(540);
  });

  it('Invalid Date を拒否する', () => {
    expect(() => toJstClock(new Date('不正な日付'))).toThrow(
      new RangeError('現在時刻に Invalid Date は渡せません'),
    );
  });

  it('実行環境のタイムゾーンに依存しない（TZ を差し替えても同じ結果）', () => {
    // TZ を差し替えると Date の各種ローカル時刻メソッドの戻り値は変わる。
    // それでも結果が変わらないことで getUTC* だけで計算していることを保証する。
    const now = new Date('2026-09-15T15:00:00Z');
    const expected = { date: '2026-09-16', dayOfWeek: 3, minuteOfDay: 0 };
    try {
      for (const timeZone of ['Asia/Tokyo', 'UTC', 'America/New_York', 'Pacific/Kiritimati']) {
        vi.stubEnv('TZ', timeZone);
        expect(toJstClock(now)).toEqual(expected);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('toJstDate（前後の余分な文字）', () => {
  it('先頭に余分な文字が付いた日付を拒否する', () => {
    expect(() => toJstDate('x2026-09-15')).toThrow(
      new RangeError('日付は YYYY-MM-DD 形式である必要があります: "x2026-09-15"'),
    );
  });

  it('末尾に余分な文字が付いた日付を拒否する', () => {
    expect(() => toJstDate('2026-09-15x')).toThrow(
      new RangeError('日付は YYYY-MM-DD 形式である必要があります: "2026-09-15x"'),
    );
  });

  it('4 桁未満の年も 0 詰めして往復できる', () => {
    // 年を 0 詰めしないと往復比較が壊れる（"999-12-31" !== "0999-12-31"）
    expect(toJstDate('0999-12-31')).toBe('0999-12-31');
    expect(addJstDays(toJstDate('1000-01-01'), -1)).toBe('0999-12-31');
  });
});
