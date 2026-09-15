import { describe, expect, it } from 'vitest';
import { RATING_MAX, RATING_MIN } from './constants';
import { summarizeRatings, toRating } from './rating';
import type { Rating } from './rating';

/** 同じ評価を count 件並べた配列を作る。 */
function repeat(rating: Rating, count: number): readonly Rating[] {
  return Array.from({ length: count }, () => rating);
}

describe('toRating', () => {
  it('下限 1 を受け入れる', () => {
    expect(toRating(1)).toBe(1);
  });

  it('上限 5 を受け入れる', () => {
    expect(toRating(5)).toBe(5);
  });

  it('0 を拒否する', () => {
    expect(() => toRating(0)).toThrow(
      new RangeError('評価は 1 〜 5 の整数である必要があります: 0'),
    );
  });

  it('6 を拒否する', () => {
    expect(() => toRating(6)).toThrow(
      new RangeError('評価は 1 〜 5 の整数である必要があります: 6'),
    );
  });

  it('小数を拒否する', () => {
    expect(() => toRating(4.5)).toThrow(
      new RangeError('評価は 1 〜 5 の整数である必要があります: 4.5'),
    );
  });

  it('NaN を拒否する', () => {
    expect(() => toRating(Number.NaN)).toThrow(
      new RangeError('評価は 1 〜 5 の整数である必要があります: NaN'),
    );
  });
});

describe('summarizeRatings', () => {
  it('0 件なら平均 0・件数 0・分布はすべて 0 を返す', () => {
    expect(summarizeRatings([])).toEqual({
      average: 0,
      count: 0,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    });
  });

  it('1 件ならその評価がそのまま平均になる', () => {
    expect(summarizeRatings([toRating(3)])).toEqual({
      average: 3,
      count: 1,
      distribution: { 1: 0, 2: 0, 3: 1, 4: 0, 5: 0 },
    });
  });

  it('平均が割り切れる場合は小数を付けない数値を返す', () => {
    expect(summarizeRatings([4, 5, 3].map(toRating)).average).toBe(4);
  });

  it('小数第 2 位以下は四捨五入して小数第 1 位に丸める', () => {
    expect(summarizeRatings([4, 5, 4, 4, 5].map(toRating)).average).toBe(4.4);
  });

  it('4.45 は 4.5 に切り上がる', () => {
    const ratings = [...repeat(5, 9), ...repeat(4, 11)];
    expect(ratings).toHaveLength(20);
    expect(summarizeRatings(ratings).average).toBe(4.5);
  });

  it('3.35 は 3.4 に切り上がる（Math.round は 0.5 を切り上げる）', () => {
    const ratings = [...repeat(4, 7), ...repeat(3, 13)];
    expect(ratings).toHaveLength(20);
    expect(summarizeRatings(ratings).average).toBe(3.4);
  });

  it('評価ごとの件数を分布として数える', () => {
    expect(summarizeRatings([5, 4, 4, 3, 5, 5, 1].map(toRating))).toEqual({
      average: 3.9,
      count: 7,
      distribution: { 1: 1, 2: 0, 3: 1, 4: 2, 5: 3 },
    });
  });

  it('件数は入力の長さと一致する', () => {
    expect(summarizeRatings(repeat(2, 123)).count).toBe(123);
  });

  it('分布の合計は件数と一致する', () => {
    const summary = summarizeRatings([1, 2, 3, 4, 5, 5, 5].map(toRating));
    const total = Object.values(summary.distribution).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(summary.count);
  });

  it('呼び出しごとに独立した分布オブジェクトを返す', () => {
    const first = summarizeRatings([toRating(1)]);
    const second = summarizeRatings([toRating(5)]);
    expect(first.distribution).toEqual({ 1: 1, 2: 0, 3: 0, 4: 0, 5: 0 });
    expect(second.distribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 });
  });

  it('元の配列を書き換えない', () => {
    const ratings = [5, 1, 3].map(toRating);
    summarizeRatings(ratings);
    expect(ratings).toEqual([5, 1, 3]);
  });
});

/**
 * `Rating` が取りうる値の一覧。
 * `satisfies` が「`Rating` に無い値が混じっていないこと」を、
 * `EVERY_RATING_IS_LISTED` が「取りこぼしが無いこと」を保証する。
 */
const ALL_RATINGS = [1, 2, 3, 4, 5] as const satisfies readonly Rating[];

/** 上の配列が `Rating` を網羅していることの型レベル検査。取りこぼすと `tsc` が落ちる */
const EVERY_RATING_IS_LISTED: Rating extends (typeof ALL_RATINGS)[number] ? true : never = true;

describe('Rating', () => {
  /**
   * `toRating` は `RATING_MIN`〜`RATING_MAX` で検証してから `as Rating` で絞り込む。
   * 成立するのは両者が一致しているからだが、その対応はコードのどこにも書かれていない。
   * 定数側だけを広げると `Rating` に無い数値が `Rating` を名乗って通り、
   * `as` が型検査を黙らせるので `tsc` も lint も気づかない。ここで縛る。
   */
  it('取りうる値が RATING_MIN 〜 RATING_MAX と過不足なく一致する', () => {
    expect(EVERY_RATING_IS_LISTED).toBe(true);
    expect(ALL_RATINGS[0]).toBe(RATING_MIN);
    expect(ALL_RATINGS.at(-1)).toBe(RATING_MAX);
    expect(ALL_RATINGS).toHaveLength(RATING_MAX - RATING_MIN + 1);
  });
});
