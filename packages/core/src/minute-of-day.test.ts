import { describe, expect, it } from 'vitest';
import { formatMinuteOfDay, minuteOfDay, toMinuteOfDay } from './minute-of-day';

describe('toMinuteOfDay', () => {
  it('下限 0 を受け入れる', () => {
    expect(toMinuteOfDay(0)).toBe(0);
  });

  it('上限 2879（翌 23:59）を受け入れる', () => {
    expect(toMinuteOfDay(2879)).toBe(2879);
  });

  it('日跨ぎ境界の 1440 を受け入れる', () => {
    expect(toMinuteOfDay(1440)).toBe(1440);
  });

  it('負の値を拒否する', () => {
    expect(() => toMinuteOfDay(-1)).toThrow(
      new RangeError('0 時からの分は 0 〜 2879 の範囲である必要があります: -1'),
    );
  });

  it('上限を 1 分超えた 2880 を拒否する', () => {
    expect(() => toMinuteOfDay(2880)).toThrow(
      new RangeError('0 時からの分は 0 〜 2879 の範囲である必要があります: 2880'),
    );
  });

  it('小数を拒否する', () => {
    expect(() => toMinuteOfDay(10.5)).toThrow(
      new RangeError('0 時からの分は整数である必要があります: 10.5'),
    );
  });

  it('NaN を拒否する', () => {
    expect(() => toMinuteOfDay(Number.NaN)).toThrow(
      new RangeError('0 時からの分は整数である必要があります: NaN'),
    );
  });

  it('Infinity を拒否する', () => {
    expect(() => toMinuteOfDay(Number.POSITIVE_INFINITY)).toThrow(
      new RangeError('0 時からの分は整数である必要があります: Infinity'),
    );
  });
});

describe('minuteOfDay', () => {
  it('0 時 0 分を 0 に変換する', () => {
    expect(minuteOfDay(0, 0)).toBe(0);
  });

  it('11 時 30 分を 690 に変換する', () => {
    expect(minuteOfDay(11, 30)).toBe(690);
  });

  it('18 時 0 分を 1080 に変換する', () => {
    expect(minuteOfDay(18, 0)).toBe(1080);
  });

  it('22 時 30 分を 1350 に変換する', () => {
    expect(minuteOfDay(22, 30)).toBe(1350);
  });

  it('23 時 59 分を 1439 に変換する', () => {
    expect(minuteOfDay(23, 59)).toBe(1439);
  });

  it('翌 1 時 30 分（25:30）を 1530 に変換する', () => {
    expect(minuteOfDay(25, 30)).toBe(1530);
  });

  it('翌 2 時 0 分（26:00）を 1560 に変換する', () => {
    expect(minuteOfDay(26, 0)).toBe(1560);
  });

  it('上限の 47 時 59 分を 2879 に変換する', () => {
    expect(minuteOfDay(47, 59)).toBe(2879);
  });

  it('48 時 0 分は範囲外として拒否する', () => {
    expect(() => minuteOfDay(48, 0)).toThrow(
      new RangeError('0 時からの分は 0 〜 2879 の範囲である必要があります: 2880'),
    );
  });

  it('分が 60 以上の値を拒否する', () => {
    expect(() => minuteOfDay(1, 60)).toThrow(
      new RangeError('分は 0 〜 59 の範囲である必要があります: 60'),
    );
  });

  it('分が負の値を拒否する', () => {
    expect(() => minuteOfDay(1, -1)).toThrow(
      new RangeError('分は 0 〜 59 の範囲である必要があります: -1'),
    );
  });

  it('時が小数の値を拒否する', () => {
    expect(() => minuteOfDay(1.5, 0)).toThrow(
      new RangeError('時と分は整数である必要があります: 1.5:0'),
    );
  });

  it('分が小数の値を拒否する', () => {
    expect(() => minuteOfDay(1, 0.5)).toThrow(
      new RangeError('時と分は整数である必要があります: 1:0.5'),
    );
  });
});

describe('formatMinuteOfDay', () => {
  it('0 分を "0:00" と表示する', () => {
    expect(formatMinuteOfDay(toMinuteOfDay(0))).toBe('0:00');
  });

  it('分は必ず 2 桁ゼロ埋めする', () => {
    expect(formatMinuteOfDay(toMinuteOfDay(5))).toBe('0:05');
  });

  it('60 分を "1:00" と表示する', () => {
    expect(formatMinuteOfDay(toMinuteOfDay(60))).toBe('1:00');
  });

  it('690 分を "11:30" と表示する', () => {
    expect(formatMinuteOfDay(toMinuteOfDay(690))).toBe('11:30');
  });

  it('1080 分を "18:00" と表示する', () => {
    expect(formatMinuteOfDay(toMinuteOfDay(1080))).toBe('18:00');
  });

  it('1439 分（当日最後の分）を "23:59" と表示する', () => {
    expect(formatMinuteOfDay(toMinuteOfDay(1439))).toBe('23:59');
  });

  it('1440 分から翌日扱いになり "翌 0:00" と表示する', () => {
    expect(formatMinuteOfDay(toMinuteOfDay(1440))).toBe('翌 0:00');
  });

  it('1530 分を "翌 1:30" と表示する', () => {
    expect(formatMinuteOfDay(toMinuteOfDay(1530))).toBe('翌 1:30');
  });

  it('1560 分を "翌 2:00" と表示する', () => {
    expect(formatMinuteOfDay(toMinuteOfDay(1560))).toBe('翌 2:00');
  });

  it('上限 2879 分を "翌 23:59" と表示する', () => {
    expect(formatMinuteOfDay(toMinuteOfDay(2879))).toBe('翌 23:59');
  });
});
