import { describe, expect, it } from 'vitest';
import { coordinate } from './coordinate';
import { encodeGeohash } from './geohash';
import { cellsForRadius, precisionForRadius } from './search-cells';

describe('precisionForRadius', () => {
  it.each([
    [0, 7],
    [1, 7],
    [100, 7],
    [100.1, 6],
    [500, 6],
    [600, 6],
    [600.1, 5],
    [1000, 5],
    [3000, 5],
    [3000.1, 4],
    [10000, 4],
    [19000, 4],
    [19000.1, 3],
    [50000, 3],
    [1000000, 3],
  ])('半径 %p m には precision %i を返す', (radiusM, expected) => {
    expect(precisionForRadius(radiusM)).toBe(expected);
  });

  it('半径が大きくなるほど precision は単調非増加である', () => {
    let previous = precisionForRadius(0);
    for (let radiusM = 0; radiusM <= 30000; radiusM += 100) {
      const current = precisionForRadius(radiusM);
      expect(current).toBeLessThanOrEqual(previous);
      previous = current;
    }
  });

  it('負の半径を拒否する', () => {
    expect(() => precisionForRadius(-1)).toThrow(
      new RangeError('半径は 0 以上である必要があります: -1'),
    );
  });

  it('NaN を拒否する', () => {
    expect(() => precisionForRadius(Number.NaN)).toThrow(
      new RangeError('半径は有限の数値である必要があります: NaN'),
    );
  });

  it('Infinity を拒否する', () => {
    expect(() => precisionForRadius(Number.POSITIVE_INFINITY)).toThrow(
      new RangeError('半径は有限の数値である必要があります: Infinity'),
    );
  });
});

describe('cellsForRadius', () => {
  const SHINJUKU_STATION = coordinate(35.689592, 139.700413);

  it('自セルと 8 近傍の 9 セルを返す', () => {
    expect(cellsForRadius(SHINJUKU_STATION, 500)).toHaveLength(9);
  });

  it('先頭は中心セルである', () => {
    expect(cellsForRadius(SHINJUKU_STATION, 500)[0]).toBe('xn774c');
  });

  it('半径に応じた精度の桁数になる', () => {
    expect(cellsForRadius(SHINJUKU_STATION, 100)[0]).toHaveLength(7);
    expect(cellsForRadius(SHINJUKU_STATION, 500)[0]).toHaveLength(6);
    expect(cellsForRadius(SHINJUKU_STATION, 2000)[0]).toHaveLength(5);
    expect(cellsForRadius(SHINJUKU_STATION, 10000)[0]).toHaveLength(4);
    expect(cellsForRadius(SHINJUKU_STATION, 50000)[0]).toHaveLength(3);
  });

  it('半径が大きいほどセルの桁数が短くなる', () => {
    const narrow = cellsForRadius(SHINJUKU_STATION, 100)[0];
    const wide = cellsForRadius(SHINJUKU_STATION, 10000)[0];
    expect(String(wide).length).toBeLessThan(String(narrow).length);
  });

  it('返すセルに重複がない', () => {
    const cells = cellsForRadius(SHINJUKU_STATION, 500);
    expect(new Set(cells).size).toBe(cells.length);
  });

  it('すべてのセルが同じ桁数である', () => {
    const cells = cellsForRadius(SHINJUKU_STATION, 500);
    for (const cell of cells) {
      expect(cell).toHaveLength(6);
    }
  });

  it('中心から半径の距離にある点が必ずいずれかのセルに含まれる', () => {
    // 3×3 セルで円を覆えているかの回帰テスト。真北・真南・真東・真西の 4 方向で確認する
    const radiusM = 500;
    const cells = new Set(cellsForRadius(SHINJUKU_STATION, radiusM));
    const precision = precisionForRadius(radiusM);
    const latitudeDeltaDeg = 500 / 111320;
    const longitudeDeltaDeg = latitudeDeltaDeg / Math.cos((35.689592 * Math.PI) / 180);
    const edges = [
      coordinate(35.689592 + latitudeDeltaDeg, 139.700413),
      coordinate(35.689592 - latitudeDeltaDeg, 139.700413),
      coordinate(35.689592, 139.700413 + longitudeDeltaDeg),
      coordinate(35.689592, 139.700413 - longitudeDeltaDeg),
    ];
    for (const edge of edges) {
      expect(cells.has(encodeGeohash(edge, precision))).toBe(true);
    }
  });

  it('極付近では近傍が減るため 9 セル未満になる', () => {
    expect(cellsForRadius(coordinate(90, 0), 50000).length).toBeLessThan(9);
  });

  it('負の半径を拒否する', () => {
    expect(() => cellsForRadius(SHINJUKU_STATION, -1)).toThrow(
      new RangeError('半径は 0 以上である必要があります: -1'),
    );
  });
});
