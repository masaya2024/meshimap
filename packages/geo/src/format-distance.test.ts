import { describe, expect, it } from 'vitest';
import { formatDistance } from './format-distance';

describe('formatDistance', () => {
  it.each([
    [0, '0m'],
    [0.4, '0m'],
    [0.5, '1m'],
    [1, '1m'],
    [499.5, '500m'],
    [999, '999m'],
    [999.4, '999m'],
  ])('%p メートルを %p と表示する', (meters, expected) => {
    expect(formatDistance(meters)).toBe(expected);
  });

  it.each([
    [999.5, '1.0km'],
    [1000, '1.0km'],
    [1049, '1.0km'],
    [1050, '1.1km'],
    [9949, '9.9km'],
    [9999, '10.0km'],
  ])('%p メートルを %p と表示する', (meters, expected) => {
    expect(formatDistance(meters)).toBe(expected);
  });

  it.each([
    [10000, '10km'],
    [10499, '10km'],
    [10500, '11km'],
    [403058.1, '403km'],
  ])('%p メートルを %p と表示する', (meters, expected) => {
    expect(formatDistance(meters)).toBe(expected);
  });

  it('負の距離を拒否する', () => {
    expect(() => formatDistance(-1)).toThrow(
      new RangeError('距離は 0 以上である必要があります: -1'),
    );
  });

  it('NaN を拒否する', () => {
    expect(() => formatDistance(Number.NaN)).toThrow(
      new RangeError('距離は有限の数値である必要があります: NaN'),
    );
  });

  it('Infinity を拒否する', () => {
    expect(() => formatDistance(Number.POSITIVE_INFINITY)).toThrow(
      new RangeError('距離は有限の数値である必要があります: Infinity'),
    );
  });
});
