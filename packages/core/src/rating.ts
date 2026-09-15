// レビュー評価の集計。D1 の reviews.rating（1〜5）を星の分布と平均にまとめる。

import { RATING_MAX, RATING_MIN } from './constants';

export type Rating = 1 | 2 | 3 | 4 | 5;

/** 星ごとの件数。棒グラフ表示にそのまま使える形にする。 */
export type RatingDistribution = { readonly [K in Rating]: number };

export type RatingSummary = {
  readonly average: number;
  readonly count: number;
  readonly distribution: RatingDistribution;
};

export function toRating(value: number): Rating {
  if (!Number.isInteger(value) || value < RATING_MIN || value > RATING_MAX) {
    throw new RangeError(
      `評価は ${RATING_MIN} 〜 ${RATING_MAX} の整数である必要があります: ${value}`,
    );
  }
  // 検証済みのリテラル union への絞り込み
  return value as Rating;
}

/** 平均は小数第 1 位に丸める。D1 の rating_avg にもこの値を保存する。 */
export function summarizeRatings(ratings: readonly Rating[]): RatingSummary {
  const distribution: Record<Rating, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let totalScore = 0;
  for (const rating of ratings) {
    distribution[rating] += 1;
    totalScore += rating;
  }
  // 0 件で 0 除算にならないよう、集計後に件数を見る
  if (ratings.length === 0) {
    return { average: 0, count: 0, distribution };
  }
  return {
    average: Math.round((totalScore / ratings.length) * 10) / 10,
    count: ratings.length,
    distribution,
  };
}
