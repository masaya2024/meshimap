import { describe, expect, it } from 'vitest';
import { coordinate, toLatitude, toLongitude, wrapLongitude } from './coordinate';

describe('toLatitude', () => {
  it('範囲内の値をそのまま返す', () => {
    expect(toLatitude(35.681236)).toBe(35.681236);
  });

  it('下限 -90 を受け入れる', () => {
    expect(toLatitude(-90)).toBe(-90);
  });

  it('上限 90 を受け入れる', () => {
    expect(toLatitude(90)).toBe(90);
  });

  it('0 を受け入れる', () => {
    expect(toLatitude(0)).toBe(0);
  });

  it('下限をわずかに下回る値を拒否する', () => {
    expect(() => toLatitude(-90.000001)).toThrow(
      new RangeError('緯度は -90 〜 90 の範囲である必要があります: -90.000001'),
    );
  });

  it('上限をわずかに上回る値を拒否する', () => {
    expect(() => toLatitude(90.000001)).toThrow(
      new RangeError('緯度は -90 〜 90 の範囲である必要があります: 90.000001'),
    );
  });

  it('NaN を拒否する', () => {
    expect(() => toLatitude(Number.NaN)).toThrow(
      new RangeError('緯度は有限の数値である必要があります: NaN'),
    );
  });

  it('Infinity を拒否する', () => {
    expect(() => toLatitude(Number.POSITIVE_INFINITY)).toThrow(
      new RangeError('緯度は有限の数値である必要があります: Infinity'),
    );
  });

  it('-Infinity を拒否する', () => {
    expect(() => toLatitude(Number.NEGATIVE_INFINITY)).toThrow(
      new RangeError('緯度は有限の数値である必要があります: -Infinity'),
    );
  });
});

describe('toLongitude', () => {
  it('範囲内の値をそのまま返す', () => {
    expect(toLongitude(139.767125)).toBe(139.767125);
  });

  it('下限 -180 を受け入れる', () => {
    expect(toLongitude(-180)).toBe(-180);
  });

  it('上限 180 を受け入れる', () => {
    expect(toLongitude(180)).toBe(180);
  });

  it('下限をわずかに下回る値を拒否する', () => {
    expect(() => toLongitude(-180.000001)).toThrow(
      new RangeError('経度は -180 〜 180 の範囲である必要があります: -180.000001'),
    );
  });

  it('上限をわずかに上回る値を拒否する', () => {
    expect(() => toLongitude(180.000001)).toThrow(
      new RangeError('経度は -180 〜 180 の範囲である必要があります: 180.000001'),
    );
  });

  it('NaN を拒否する', () => {
    expect(() => toLongitude(Number.NaN)).toThrow(
      new RangeError('経度は有限の数値である必要があります: NaN'),
    );
  });

  it('Infinity を拒否する', () => {
    expect(() => toLongitude(Number.POSITIVE_INFINITY)).toThrow(
      new RangeError('経度は有限の数値である必要があります: Infinity'),
    );
  });
});

describe('coordinate', () => {
  it('緯度経度を保持したオブジェクトを返す', () => {
    expect(coordinate(35.681236, 139.767125)).toEqual({
      latitude: 35.681236,
      longitude: 139.767125,
    });
  });

  it('緯度が不正なら経度を検証する前に例外を投げる', () => {
    expect(() => coordinate(91, 999)).toThrow(
      new RangeError('緯度は -90 〜 90 の範囲である必要があります: 91'),
    );
  });

  it('経度が不正なら例外を投げる', () => {
    expect(() => coordinate(35, 181)).toThrow(
      new RangeError('経度は -180 〜 180 の範囲である必要があります: 181'),
    );
  });
});

describe('wrapLongitude', () => {
  it.each([
    [0, 0],
    [139.7, 139.7],
    [-179.99, -179.99],
    [180, -180],
    [-180, -180],
    [180.01, -179.99],
    [-180.01, 179.99],
    [360, 0],
    [-360, 0],
    [540, -180],
  ])('経度 %p を %p へ折り返す', (input, expected) => {
    expect(wrapLongitude(input)).toBeCloseTo(expected, 9);
  });

  it('範囲内の値は変換しない', () => {
    expect(wrapLongitude(-180)).toBe(-180);
    expect(wrapLongitude(179.999)).toBe(179.999);
  });

  it('折り返した結果は必ず有効な経度である', () => {
    for (let value = -720; value <= 720; value += 7) {
      const wrapped = wrapLongitude(value);
      expect(wrapped).toBeGreaterThanOrEqual(-180);
      expect(wrapped).toBeLessThan(180);
    }
  });
});
