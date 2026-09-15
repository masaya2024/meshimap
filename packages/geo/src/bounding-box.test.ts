import { describe, expect, it } from 'vitest';
import { boundingBox, isWithinBounds } from './bounding-box';
import { coordinate } from './coordinate';

const SHINJUKU_STATION = coordinate(35.689592, 139.700413);

describe('boundingBox', () => {
  it('新宿駅から半径 1000m の矩形を返す', () => {
    const bounds = boundingBox(SHINJUKU_STATION, 1000);
    expect(bounds.latitudeMin).toBeCloseTo(35.68059879636275, 9);
    expect(bounds.latitudeMax).toBeCloseTo(35.69858520363724, 9);
    expect(bounds.longitudeMin).toBeCloseTo(139.68934021038626, 9);
    expect(bounds.longitudeMax).toBeCloseTo(139.71148578961368, 9);
  });

  it('半径 0 では中心と一致する', () => {
    const bounds = boundingBox(coordinate(35, 139), 0);
    expect(bounds.latitudeMin).toBe(35);
    expect(bounds.latitudeMax).toBe(35);
    expect(bounds.longitudeMin).toBe(139);
    expect(bounds.longitudeMax).toBe(139);
  });

  it('中心は矩形の内側にある', () => {
    const bounds = boundingBox(SHINJUKU_STATION, 1000);
    expect(bounds.latitudeMin).toBeLessThan(SHINJUKU_STATION.latitude);
    expect(bounds.latitudeMax).toBeGreaterThan(SHINJUKU_STATION.latitude);
    expect(bounds.longitudeMin).toBeLessThan(SHINJUKU_STATION.longitude);
    expect(bounds.longitudeMax).toBeGreaterThan(SHINJUKU_STATION.longitude);
  });

  it('赤道上では緯度の幅と経度の幅がほぼ等しい', () => {
    const bounds = boundingBox(coordinate(0, 0), 1000);
    expect(bounds.longitudeMax - bounds.longitudeMin).toBeCloseTo(
      bounds.latitudeMax - bounds.latitudeMin,
      9,
    );
  });

  it('高緯度ほど経度の幅が緯度の幅より広がる', () => {
    const equator = boundingBox(coordinate(0, 0), 1000);
    const highLatitude = boundingBox(coordinate(60, 0), 1000);
    expect(highLatitude.longitudeMax - highLatitude.longitudeMin).toBeGreaterThan(
      equator.longitudeMax - equator.longitudeMin,
    );
  });

  it('緯度 89 度でも経度の幅は有限である', () => {
    const bounds = boundingBox(coordinate(89, 0), 1000);
    expect(bounds.longitudeMin).toBeCloseTo(-0.515298773814493, 9);
    expect(bounds.longitudeMax).toBeCloseTo(0.515298773814493, 9);
  });

  it('北極を含む円は全経度を覆う', () => {
    const bounds = boundingBox(coordinate(90, 0), 1000);
    expect(bounds.latitudeMin).toBeCloseTo(89.99100679636275, 9);
    expect(bounds.latitudeMax).toBe(90);
    expect(bounds.longitudeMin).toBe(-180);
    expect(bounds.longitudeMax).toBe(180);
  });

  it('南極を含む円は全経度を覆う', () => {
    const bounds = boundingBox(coordinate(-90, 0), 1000);
    expect(bounds.latitudeMin).toBe(-90);
    expect(bounds.latitudeMax).toBeCloseTo(-89.99100679636275, 9);
    expect(bounds.longitudeMin).toBe(-180);
    expect(bounds.longitudeMax).toBe(180);
  });

  it('地球全体を覆う半径では全経度・全緯度になる', () => {
    // 極でクランプされる規則が無いと、経度 179.86〜180 度の帯が漏れる
    const bounds = boundingBox(coordinate(0, 0), 20000000);
    expect(bounds.latitudeMin).toBe(-90);
    expect(bounds.latitudeMax).toBe(90);
    expect(bounds.longitudeMin).toBe(-180);
    expect(bounds.longitudeMax).toBe(180);
  });

  it('日付変更線を跨ぐと最小経度が最大経度より大きくなる', () => {
    const bounds = boundingBox(coordinate(0, 179.99), 5000);
    expect(bounds.longitudeMin).toBeCloseTo(179.94503398181382, 9);
    expect(bounds.longitudeMax).toBeCloseTo(-179.9650339818138, 9);
    expect(bounds.longitudeMin).toBeGreaterThan(bounds.longitudeMax);
  });

  it('西回りで日付変更線を跨ぐ場合も折り返す', () => {
    const bounds = boundingBox(coordinate(0, -179.99), 5000);
    expect(bounds.longitudeMin).toBeCloseTo(179.9650339818138, 9);
    expect(bounds.longitudeMax).toBeCloseTo(-179.94503398181382, 9);
  });

  it('負の半径を拒否する', () => {
    expect(() => boundingBox(SHINJUKU_STATION, -1)).toThrow(
      new RangeError('半径は 0 以上である必要があります: -1'),
    );
  });

  it('NaN の半径を拒否する', () => {
    expect(() => boundingBox(SHINJUKU_STATION, Number.NaN)).toThrow(
      new RangeError('半径は有限の数値である必要があります: NaN'),
    );
  });

  it('Infinity の半径を拒否する', () => {
    expect(() => boundingBox(SHINJUKU_STATION, Number.POSITIVE_INFINITY)).toThrow(
      new RangeError('半径は有限の数値である必要があります: Infinity'),
    );
  });
});

describe('isWithinBounds', () => {
  const bounds = boundingBox(SHINJUKU_STATION, 1000);

  it('中心は内側である', () => {
    expect(isWithinBounds(SHINJUKU_STATION, bounds)).toBe(true);
  });

  it('南西の角（境界線上）は内側である', () => {
    expect(isWithinBounds(coordinate(bounds.latitudeMin, bounds.longitudeMin), bounds)).toBe(true);
  });

  it('北東の角（境界線上）は内側である', () => {
    expect(isWithinBounds(coordinate(bounds.latitudeMax, bounds.longitudeMax), bounds)).toBe(true);
  });

  it('緯度が上限をわずかに超えると外側である', () => {
    expect(
      isWithinBounds(coordinate(bounds.latitudeMax + 0.0001, bounds.longitudeMin), bounds),
    ).toBe(false);
  });

  it('緯度が下限をわずかに下回ると外側である', () => {
    expect(
      isWithinBounds(coordinate(bounds.latitudeMin - 0.0001, bounds.longitudeMin), bounds),
    ).toBe(false);
  });

  it('経度が上限をわずかに超えると外側である', () => {
    expect(
      isWithinBounds(coordinate(bounds.latitudeMin, bounds.longitudeMax + 0.0001), bounds),
    ).toBe(false);
  });

  it('経度が下限をわずかに下回ると外側である', () => {
    expect(
      isWithinBounds(coordinate(bounds.latitudeMin, bounds.longitudeMin - 0.0001), bounds),
    ).toBe(false);
  });

  it('約 6km 離れた東京駅は半径 1000m の矩形の外側である', () => {
    expect(isWithinBounds(coordinate(35.681236, 139.767125), bounds)).toBe(false);
  });

  it('最小経度と最大経度が等しい矩形は AND 判定になる', () => {
    // 半径 0 では longitudeMin === longitudeMax になる。
    // ここを「未満」で判定すると日付変更線跨ぎ扱い（OR）へ落ち、
    // 範囲外の経度まで内側と誤判定してしまう
    const zeroRadius = boundingBox(coordinate(35, 139), 0);
    expect(isWithinBounds(coordinate(35, 139), zeroRadius)).toBe(true);
    expect(isWithinBounds(coordinate(35, 140), zeroRadius)).toBe(false);
  });

  describe('日付変更線を跨ぐ矩形', () => {
    const crossing = boundingBox(coordinate(0, 179.99), 5000);

    it('東経側の点は内側である', () => {
      expect(isWithinBounds(coordinate(0, 179.99), crossing)).toBe(true);
    });

    it('西経側へ折り返した点も内側である', () => {
      expect(isWithinBounds(coordinate(0, -179.99), crossing)).toBe(true);
    });

    it('経度 180 度ちょうどは ±180 のどちらの表現でも内側である', () => {
      // 矩形は longitudeMin=179.945034 / longitudeMax=-179.965034。
      // 180 は下限 179.945034 以上なので OR の左辺で内側、
      // -180 は上限 -179.965034 以下なので OR の右辺で内側になる。
      // 同じ地点を ±180 のどちらで表しても判定が一致することを固定する
      expect(isWithinBounds(coordinate(0, 180), crossing)).toBe(true);
      expect(isWithinBounds(coordinate(0, -180), crossing)).toBe(true);
    });

    it('下限の経度ちょうどは内側である', () => {
      expect(isWithinBounds(coordinate(0, crossing.longitudeMin), crossing)).toBe(true);
    });

    it('上限の経度ちょうどは内側である', () => {
      expect(isWithinBounds(coordinate(0, crossing.longitudeMax), crossing)).toBe(true);
    });

    it('東経側の範囲外は外側である', () => {
      expect(isWithinBounds(coordinate(0, 179.94), crossing)).toBe(false);
    });

    it('本初子午線上の点は外側である', () => {
      expect(isWithinBounds(coordinate(0, 0), crossing)).toBe(false);
    });

    it('緯度が範囲外なら経度が内側でも外側である', () => {
      expect(isWithinBounds(coordinate(45, 179.99), crossing)).toBe(false);
    });
  });
});
