import { describe, expect, it } from 'vitest';
import { BUDGET_UNSET_LABEL, formatBudgetRange, formatYen } from './budget';

describe('formatYen', () => {
  it('0 円を "¥0" と表示する', () => {
    expect(formatYen(0)).toBe('¥0');
  });

  it('3 桁までは区切り記号を入れない', () => {
    expect(formatYen(999)).toBe('¥999');
  });

  it('4 桁から 3 桁ごとにカンマを入れる', () => {
    expect(formatYen(1000)).toBe('¥1,000');
  });

  it('5 桁を正しく区切る', () => {
    expect(formatYen(12345)).toBe('¥12,345');
  });

  it('上限 100 万円を正しく区切る', () => {
    expect(formatYen(1_000_000)).toBe('¥1,000,000');
  });

  it('上限を 1 円超えたら拒否する', () => {
    expect(() => formatYen(1_000_001)).toThrow(
      new RangeError('予算は 0 〜 1000000 円の整数である必要があります: 1000001'),
    );
  });

  it('負の値を拒否する', () => {
    expect(() => formatYen(-1)).toThrow(
      new RangeError('予算は 0 〜 1000000 円の整数である必要があります: -1'),
    );
  });

  it('小数を拒否する', () => {
    expect(() => formatYen(1000.5)).toThrow(
      new RangeError('予算は 0 〜 1000000 円の整数である必要があります: 1000.5'),
    );
  });

  it('端末のロケール実装に依存せず ja-JP の桁区切りと一致する', () => {
    for (const value of [0, 1, 999, 1000, 1500, 12345, 100000, 1000000]) {
      expect(formatYen(value)).toBe(`¥${value.toLocaleString('ja-JP')}`);
    }
  });
});

describe('formatBudgetRange', () => {
  it('下限と上限が揃っていれば範囲として表示する', () => {
    expect(formatBudgetRange(1000, 3000)).toBe('¥1,000 〜 ¥3,000');
  });

  it('下限と上限が同額なら 1 つだけ表示する', () => {
    expect(formatBudgetRange(2000, 2000)).toBe('¥2,000');
  });

  it('上限が未設定なら下限に「〜」を後置する', () => {
    expect(formatBudgetRange(1000, null)).toBe('¥1,000 〜');
  });

  it('下限が未設定なら上限に「〜」を前置する', () => {
    expect(formatBudgetRange(null, 3000)).toBe('〜 ¥3,000');
  });

  it('どちらも未設定なら未設定ラベルを返す', () => {
    expect(formatBudgetRange(null, null)).toBe(BUDGET_UNSET_LABEL);
    expect(BUDGET_UNSET_LABEL).toBe('－');
  });

  it('0 円同士は "¥0" と表示する（null と 0 を混同しない）', () => {
    expect(formatBudgetRange(0, 0)).toBe('¥0');
  });

  it('下限 0 円の範囲を表示できる', () => {
    expect(formatBudgetRange(0, 999)).toBe('¥0 〜 ¥999');
  });

  it('下限が上限より大きい場合は拒否する', () => {
    expect(() => formatBudgetRange(3000, 1000)).toThrow(
      new RangeError('予算の下限は上限以下である必要があります: 3000 > 1000'),
    );
  });

  it('範囲外の下限は formatYen の検証で拒否される', () => {
    expect(() => formatBudgetRange(-1, 1000)).toThrow(
      new RangeError('予算は 0 〜 1000000 円の整数である必要があります: -1'),
    );
  });

  it('範囲外の上限は formatYen の検証で拒否される', () => {
    expect(() => formatBudgetRange(null, 1_000_001)).toThrow(
      new RangeError('予算は 0 〜 1000000 円の整数である必要があります: 1000001'),
    );
  });
});
