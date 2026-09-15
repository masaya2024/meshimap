import { describe, expect, it } from 'vitest';
import { coordinate } from './coordinate';
import { distanceMeters } from './distance';

// 実測で確定した既知の座標（テスト間で共有する）
const TOKYO_STATION = coordinate(35.681236, 139.767125);
const OSAKA_STATION = coordinate(34.702485, 135.495951);
const SHIBUYA_STATION = coordinate(35.658034, 139.701636);
const SHINJUKU_STATION = coordinate(35.689592, 139.700413);

describe('distanceMeters', () => {
  it('同一点の距離は 0 である', () => {
    expect(distanceMeters(TOKYO_STATION, TOKYO_STATION)).toBe(0);
  });

  it('東京駅から大阪駅までの距離が実測値と一致する', () => {
    expect(distanceMeters(TOKYO_STATION, OSAKA_STATION)).toBeCloseTo(403058.1, 1);
  });

  it('東京駅から渋谷駅までの距離が実測値と一致する', () => {
    expect(distanceMeters(TOKYO_STATION, SHIBUYA_STATION)).toBeCloseTo(6454.0, 1);
  });

  it('渋谷駅から新宿駅までの距離が実測値と一致する', () => {
    expect(distanceMeters(SHIBUYA_STATION, SHINJUKU_STATION)).toBeCloseTo(3510.8, 1);
  });

  it('距離は対称である（引数の順序を入れ替えても同じ）', () => {
    expect(distanceMeters(TOKYO_STATION, OSAKA_STATION)).toBe(
      distanceMeters(OSAKA_STATION, TOKYO_STATION),
    );
  });

  it('赤道上の経度 1 度は約 111195m である', () => {
    expect(distanceMeters(coordinate(0, 0), coordinate(0, 1))).toBeCloseTo(111195.1, 1);
  });

  it('日付変更線を跨ぐ距離を短い側で計算する', () => {
    // 経度を単純に引き算すると 359.8 度分（約 4 万 km）になってしまう
    expect(distanceMeters(coordinate(0, 179.9), coordinate(0, -179.9))).toBeCloseTo(22239.0, 1);
  });

  it('対蹠点の距離は地球半周（πR）である', () => {
    // 浮動小数点誤差で sqrt の引数が 1 をわずかに超えると asin が NaN を返す。
    // Math.min(1, …) のクランプが無いとこのテストが落ちる
    expect(distanceMeters(coordinate(0, 0), coordinate(0, 180))).toBeCloseTo(20015114.4, 1);
  });

  it('北極と南極の距離は地球半周である', () => {
    expect(distanceMeters(coordinate(90, 0), coordinate(-90, 0))).toBeCloseTo(20015114.4, 1);
  });

  it('極付近の経度差は距離にほとんど寄与しない', () => {
    // 緯度 89.9 度で経度 180 度離れていても、極を挟んだ 22km 程度にしかならない
    expect(distanceMeters(coordinate(89.9, 0), coordinate(89.9, 180))).toBeCloseTo(22239.0, 1);
  });

  it('常に 0 以上を返す', () => {
    expect(distanceMeters(OSAKA_STATION, TOKYO_STATION)).toBeGreaterThan(0);
    expect(distanceMeters(coordinate(-35, -139), coordinate(35, 139))).toBeGreaterThan(0);
  });
});
