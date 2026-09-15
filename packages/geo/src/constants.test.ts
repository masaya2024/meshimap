import { describe, expect, it } from 'vitest';
import {
  DEGREES_TO_RADIANS,
  EARTH_RADIUS_M,
  GEOHASH_BASE32,
  LATITUDE_MAX,
  LATITUDE_MIN,
  LONGITUDE_MAX,
  LONGITUDE_MIN,
} from './constants';

describe('地理定数', () => {
  it('地球半径は IUGG 平均半径（6371008.8m）である', () => {
    expect(EARTH_RADIUS_M).toBe(6371008.8);
  });

  it('度からラジアンへの変換係数は π/180 である', () => {
    expect(DEGREES_TO_RADIANS).toBe(Math.PI / 180);
  });

  it('geohash の基数表は 32 文字である', () => {
    expect(GEOHASH_BASE32).toHaveLength(32);
  });

  it('geohash の基数表は標準の base32（a/i/l/o を除く）である', () => {
    expect(GEOHASH_BASE32).toBe('0123456789bcdefghjkmnpqrstuvwxyz');
  });

  it('geohash の基数表に重複文字がない', () => {
    expect(new Set(GEOHASH_BASE32).size).toBe(GEOHASH_BASE32.length);
  });

  it('緯度の範囲は -90 〜 90 である', () => {
    expect(LATITUDE_MIN).toBe(-90);
    expect(LATITUDE_MAX).toBe(90);
  });

  it('経度の範囲は -180 〜 180 である', () => {
    expect(LONGITUDE_MIN).toBe(-180);
    expect(LONGITUDE_MAX).toBe(180);
  });
});
