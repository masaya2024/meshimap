import { describe, expect, it } from 'vitest';
import { clusterByGrid, precisionForZoom } from './cluster';
import type { GridPoint } from './cluster';
import { coordinate } from './coordinate';

// 実測でセル割り当てを確認済みの 5 点
const POINTS: readonly GridPoint<string>[] = [
  { coordinate: coordinate(35.689592, 139.700413), value: 'A' }, // 新宿駅
  { coordinate: coordinate(35.69, 139.7009), value: 'B' }, // 新宿駅のすぐ隣
  { coordinate: coordinate(35.658034, 139.701636), value: 'C' }, // 渋谷駅
  { coordinate: coordinate(35.681236, 139.767125), value: 'D' }, // 東京駅
  { coordinate: coordinate(34.702485, 135.495951), value: 'E' }, // 大阪駅
];

describe('precisionForZoom', () => {
  it.each([
    [0, 2],
    [4, 2],
    [5, 3],
    [7, 3],
    [8, 4],
    [10, 4],
    [11, 5],
    [13, 5],
    [14, 6],
    [16, 6],
    [17, 7],
    [22, 7],
  ])('zoom %i には precision %i を返す', (zoom, expected) => {
    expect(precisionForZoom(zoom)).toBe(expected);
  });

  it('ズームが上がるほど precision は単調非減少である', () => {
    let previous = precisionForZoom(0);
    for (let zoom = 0; zoom <= 22; zoom += 1) {
      const current = precisionForZoom(zoom);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it('負のズームを拒否する', () => {
    expect(() => precisionForZoom(-1)).toThrow(
      new RangeError('ズームは 0 〜 22 の範囲である必要があります: -1'),
    );
  });

  it('上限を超えるズームを拒否する', () => {
    expect(() => precisionForZoom(23)).toThrow(
      new RangeError('ズームは 0 〜 22 の範囲である必要があります: 23'),
    );
  });

  it('NaN を拒否する', () => {
    expect(() => precisionForZoom(Number.NaN)).toThrow(
      new RangeError('ズームは有限の数値である必要があります: NaN'),
    );
  });
});

describe('clusterByGrid', () => {
  it('空配列には空配列を返す', () => {
    expect(clusterByGrid([], 15)).toEqual([]);
  });

  it('1 点だけなら 1 クラスタになる', () => {
    const clusters = clusterByGrid(
      [{ coordinate: coordinate(35.689592, 139.700413), value: 'A' }],
      15,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.values).toEqual(['A']);
  });

  it('zoom 15（precision 6）では 4 クラスタに分かれる', () => {
    const clusters = clusterByGrid(POINTS, 15);
    expect(clusters.map((cluster) => cluster.cell)).toEqual([
      'xn0m7m',
      'xn76fg',
      'xn76ur',
      'xn774c',
    ]);
  });

  it('同じセルの点は 1 クラスタにまとまる', () => {
    const clusters = clusterByGrid(POINTS, 15);
    const shinjuku = clusters.find((cluster) => cluster.cell === 'xn774c');
    expect(shinjuku?.values).toEqual(['A', 'B']);
  });

  it('zoom 9（precision 4）ではクラスタ数が減る', () => {
    const clusters = clusterByGrid(POINTS, 9);
    expect(clusters.map((cluster) => cluster.cell)).toEqual(['xn0m', 'xn76', 'xn77']);
  });

  it('ズームを上げるとクラスタが分裂する', () => {
    expect(clusterByGrid(POINTS, 15).length).toBeGreaterThan(clusterByGrid(POINTS, 9).length);
  });

  it('クラスタの中心は所属点の重心である', () => {
    const clusters = clusterByGrid(POINTS, 15);
    const shinjuku = clusters.find((cluster) => cluster.cell === 'xn774c');
    expect(shinjuku?.center.latitude).toBeCloseTo(35.689796, 9);
    expect(shinjuku?.center.longitude).toBeCloseTo(139.7006565, 9);
  });

  it('1 点のクラスタの中心はその点自身である', () => {
    const clusters = clusterByGrid(POINTS, 15);
    const osaka = clusters.find((cluster) => cluster.cell === 'xn0m7m');
    expect(osaka?.center).toEqual({ latitude: 34.702485, longitude: 135.495951 });
  });

  it('すべての点がいずれかのクラスタに属する', () => {
    const clusters = clusterByGrid(POINTS, 15);
    const collected = clusters.flatMap((cluster) => [...cluster.values]);
    expect([...collected].sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('クラスタはセルの辞書順に並ぶ', () => {
    const cells = clusterByGrid(POINTS, 15).map((cluster) => cluster.cell);
    expect(cells).toEqual([...cells].sort());
  });

  it('入力順が変わっても同じ結果になる', () => {
    const reversed = [...POINTS].reverse();
    expect(clusterByGrid(reversed, 15).map((cluster) => cluster.cell)).toEqual(
      clusterByGrid(POINTS, 15).map((cluster) => cluster.cell),
    );
  });

  it('文字列以外の値も保持できる', () => {
    const shopPoints: readonly GridPoint<{ id: number }>[] = [
      { coordinate: coordinate(35.689592, 139.700413), value: { id: 1 } },
    ];
    expect(clusterByGrid(shopPoints, 15)[0]?.values).toEqual([{ id: 1 }]);
  });

  it('不正なズームを拒否する', () => {
    expect(() => clusterByGrid(POINTS, 99)).toThrow(
      new RangeError('ズームは 0 〜 22 の範囲である必要があります: 99'),
    );
  });
});
