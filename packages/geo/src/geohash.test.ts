import { describe, expect, it } from 'vitest';
import { coordinate } from './coordinate';
import { decodeGeohash, encodeGeohash, neighborCells, toGeohash } from './geohash';

const TOKYO_STATION = coordinate(35.681236, 139.767125);
const OSAKA_STATION = coordinate(34.702485, 135.495951);
const SHINJUKU_STATION = coordinate(35.689592, 139.700413);

describe('encodeGeohash', () => {
  it('Wikipedia の標準ベクタと一致する', () => {
    expect(encodeGeohash(coordinate(57.64911, 10.40744), 11)).toBe('u4pruydqqvj');
  });

  it('東京駅を precision 6 でエンコードする', () => {
    expect(encodeGeohash(TOKYO_STATION, 6)).toBe('xn76ur');
  });

  it('東京駅を precision 9 でエンコードする', () => {
    expect(encodeGeohash(TOKYO_STATION, 9)).toBe('xn76urx66');
  });

  it('大阪駅を precision 6 でエンコードする', () => {
    expect(encodeGeohash(OSAKA_STATION, 6)).toBe('xn0m7m');
  });

  it('新宿駅を precision 6 でエンコードする', () => {
    expect(encodeGeohash(SHINJUKU_STATION, 6)).toBe('xn774c');
  });

  it('原点 (0, 0) は s から始まる', () => {
    expect(encodeGeohash(coordinate(0, 0), 9)).toBe('s00000000');
  });

  it('precision の文字数だけ返す', () => {
    for (let precision = 1; precision <= 12; precision += 1) {
      // GeohashPrecision の全域を走査するためのループ
      expect(encodeGeohash(TOKYO_STATION, precision as 1)).toHaveLength(precision);
    }
  });

  it('precision を 1 増やしても前方一致は保たれる', () => {
    const shorter = encodeGeohash(TOKYO_STATION, 6);
    const longer = encodeGeohash(TOKYO_STATION, 7);
    expect(longer.startsWith(shorter)).toBe(true);
  });

  it('近い 2 点は長い共通接頭辞を持つ', () => {
    const shibuya = encodeGeohash(coordinate(35.658034, 139.701636), 6);
    expect(encodeGeohash(TOKYO_STATION, 6).slice(0, 4)).toBe(shibuya.slice(0, 4));
  });

  it('遠い 2 点は共通接頭辞が短い', () => {
    expect(encodeGeohash(TOKYO_STATION, 6).slice(0, 3)).not.toBe(
      encodeGeohash(OSAKA_STATION, 6).slice(0, 3),
    );
  });

  it('base32 に含まれる文字だけを返す', () => {
    expect(encodeGeohash(TOKYO_STATION, 12)).toMatch(/^[0-9bcdefghjkmnpqrstuvwxyz]+$/);
  });

  it('南西の端 (-90, -180) をエンコードできる', () => {
    expect(encodeGeohash(coordinate(-90, -180), 6)).toBe('000000');
  });

  it('北東の端 (90, 180) をエンコードできる', () => {
    expect(encodeGeohash(coordinate(90, 180), 6)).toBe('zzzzzz');
  });
});

describe('toGeohash', () => {
  it('正しい geohash 文字列をそのまま返す', () => {
    expect(toGeohash('xn76ur')).toBe('xn76ur');
  });

  it('空文字を拒否する', () => {
    expect(() => toGeohash('')).toThrow(
      new RangeError('geohash の桁数は 1 〜 12 である必要があります: ""'),
    );
  });

  it('13 桁以上を拒否する', () => {
    expect(() => toGeohash('xn76urx6606pb')).toThrow(
      new RangeError('geohash の桁数は 1 〜 12 である必要があります: "xn76urx6606pb"'),
    );
  });

  it.each(['a', 'i', 'l', 'o'])('base32 から除外された文字 %p を拒否する', (character) => {
    expect(() => toGeohash(character)).toThrow(
      new RangeError(`geohash に使用できない文字が含まれています: "${character}"`),
    );
  });

  it('大文字を拒否する', () => {
    expect(() => toGeohash('XN76UR')).toThrow(
      new RangeError('geohash に使用できない文字が含まれています: "XN76UR"'),
    );
  });

  it('記号を拒否する', () => {
    expect(() => toGeohash('xn76-r')).toThrow(
      new RangeError('geohash に使用できない文字が含まれています: "xn76-r"'),
    );
  });

  it('12 桁ちょうどを受け入れる', () => {
    expect(toGeohash('xn76urx6606p')).toBe('xn76urx6606p');
  });
});

describe('decodeGeohash', () => {
  it('precision 6 のセル境界を返す', () => {
    expect(decodeGeohash(toGeohash('xn76ur'))).toEqual({
      latitudeMin: 35.6781005859375,
      latitudeMax: 35.68359375,
      longitudeMin: 139.757080078125,
      longitudeMax: 139.76806640625,
      center: { latitude: 35.68084716796875, longitude: 139.7625732421875 },
    });
  });

  it('1 桁の geohash は世界を 32 分割したセルを表す', () => {
    const bounds = decodeGeohash(toGeohash('s'));
    expect(bounds.latitudeMin).toBe(0);
    expect(bounds.latitudeMax).toBe(45);
    expect(bounds.longitudeMin).toBe(0);
    expect(bounds.longitudeMax).toBe(45);
  });

  it('最小のセル "0" は南西の隅である', () => {
    const bounds = decodeGeohash(toGeohash('0'));
    expect(bounds.latitudeMin).toBe(-90);
    expect(bounds.longitudeMin).toBe(-180);
  });

  it('最大のセル "z" は北東の隅である', () => {
    const bounds = decodeGeohash(toGeohash('z'));
    expect(bounds.latitudeMax).toBe(90);
    expect(bounds.longitudeMax).toBe(180);
  });

  it('中心は境界の中点である', () => {
    const bounds = decodeGeohash(toGeohash('xn774c'));
    expect(bounds.center.latitude).toBe((bounds.latitudeMin + bounds.latitudeMax) / 2);
    expect(bounds.center.longitude).toBe((bounds.longitudeMin + bounds.longitudeMax) / 2);
  });

  it.each([6, 9, 12] as const)('precision %i でエンコードと往復する', (precision) => {
    const original = encodeGeohash(TOKYO_STATION, precision);
    const center = decodeGeohash(original).center;
    expect(encodeGeohash(center, precision)).toBe(original);
  });

  it('precision が上がるほどセルが小さくなる', () => {
    const coarse = decodeGeohash(encodeGeohash(TOKYO_STATION, 5));
    const fine = decodeGeohash(encodeGeohash(TOKYO_STATION, 6));
    expect(fine.latitudeMax - fine.latitudeMin).toBeLessThan(
      coarse.latitudeMax - coarse.latitudeMin,
    );
  });

  it('元の座標はデコードしたセルの内側にある', () => {
    const bounds = decodeGeohash(encodeGeohash(TOKYO_STATION, 9));
    expect(TOKYO_STATION.latitude).toBeGreaterThanOrEqual(bounds.latitudeMin);
    expect(TOKYO_STATION.latitude).toBeLessThanOrEqual(bounds.latitudeMax);
    expect(TOKYO_STATION.longitude).toBeGreaterThanOrEqual(bounds.longitudeMin);
    expect(TOKYO_STATION.longitude).toBeLessThanOrEqual(bounds.longitudeMax);
  });
});

describe('neighborCells', () => {
  it('新宿駅のセルの 8 近傍を時計回りに返す', () => {
    expect(neighborCells(toGeohash('xn774c'))).toEqual([
      'xn774f',
      'xn7754',
      'xn7751',
      'xn7750',
      'xn774b',
      'xn7748',
      'xn7749',
      'xn774d',
    ]);
  });

  it('東京駅のセルの 8 近傍を返す', () => {
    expect(neighborCells(toGeohash('xn76ur'))).toEqual([
      'xn77h2',
      'xn77h8',
      'xn76ux',
      'xn76uw',
      'xn76uq',
      'xn76un',
      'xn76up',
      'xn77h0',
    ]);
  });

  it('1 桁のセルでも 8 近傍を返す', () => {
    expect(neighborCells(toGeohash('s'))).toEqual(['u', 'v', 't', 'm', 'k', '7', 'e', 'g']);
  });

  it('近傍は自分自身を含まない', () => {
    const cell = toGeohash('xn774c');
    expect(neighborCells(cell)).not.toContain(cell);
  });

  it('近傍に重複がない', () => {
    const cells = neighborCells(toGeohash('xn774c'));
    expect(new Set(cells).size).toBe(cells.length);
  });

  it('近傍は入力と同じ桁数である', () => {
    for (const cell of neighborCells(toGeohash('xn76urx66'))) {
      expect(cell).toHaveLength(9);
    }
  });

  it('近傍関係は対称である', () => {
    const cell = toGeohash('xn774c');
    for (const neighbor of neighborCells(cell)) {
      expect(neighborCells(neighbor)).toContain(cell);
    }
  });

  it('経度 180 度線を跨いで折り返す', () => {
    const cell = encodeGeohash(coordinate(0, 179.99), 3);
    expect(neighborCells(cell)).toEqual(['xbr', '802', '800', '2pb', 'rzz', 'rzy', 'xbn', 'xbq']);
  });

  it('北極のセルは緯度 90 度を超える近傍を返さない', () => {
    const cell = encodeGeohash(coordinate(90, 0), 3);
    expect(cell).toBe('upb');
    expect(neighborCells(cell)).toEqual(['upc', 'up9', 'up8', 'gzx', 'gzz']);
  });

  it('南極のセルは緯度 -90 度を下回る近傍を返さない', () => {
    const cell = encodeGeohash(coordinate(-90, 0), 3);
    expect(cell).toBe('h00');
    expect(neighborCells(cell)).toEqual(['h02', 'h03', 'h01', '5bp', '5br']);
  });
});
