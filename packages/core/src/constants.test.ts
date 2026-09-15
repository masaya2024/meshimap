import { describe, expect, it } from 'vitest';
import {
  BUDGET_YEN_MAX,
  BUDGET_YEN_MIN,
  CLOSING_SOON_THRESHOLD_MINUTES,
  DAYS_PER_WEEK,
  DAY_OF_WEEK_MAX,
  DAY_OF_WEEK_MIN,
  HOURS_PER_DAY,
  JST_OFFSET_MINUTES,
  MILLISECONDS_PER_DAY,
  MILLISECONDS_PER_MINUTE,
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  MINUTE_OF_DAY_MAX,
  MINUTE_OF_DAY_MIN,
} from './constants';

// 定数そのもののテストは一見無意味だが、(a) 単位の取り違え（分とミリ秒）を検知する、
// (b) 定数同士の整合（MILLISECONDS_PER_MINUTE * MINUTES_PER_DAY === MILLISECONDS_PER_DAY）を
// 保証する、という 2 つの役目がある。

describe('時間の定数', () => {
  it('1 時間は 60 分である', () => {
    expect(MINUTES_PER_HOUR).toBe(60);
  });

  it('1 日は 1440 分である', () => {
    expect(MINUTES_PER_DAY).toBe(MINUTES_PER_HOUR * HOURS_PER_DAY);
    expect(MINUTES_PER_DAY).toBe(1440);
  });

  it('0 時からの分は 0 〜 2879（翌 23:59）の範囲である', () => {
    expect(MINUTE_OF_DAY_MIN).toBe(0);
    expect(MINUTE_OF_DAY_MAX).toBe(MINUTES_PER_DAY * 2 - 1);
    expect(MINUTE_OF_DAY_MAX).toBe(2879);
  });

  it('JST は UTC+9（540 分）である', () => {
    expect(JST_OFFSET_MINUTES).toBe(9 * MINUTES_PER_HOUR);
    expect(JST_OFFSET_MINUTES).toBe(540);
  });

  it('ミリ秒の換算定数が分・日と整合する', () => {
    expect(MILLISECONDS_PER_MINUTE).toBe(60_000);
    expect(MILLISECONDS_PER_DAY).toBe(MILLISECONDS_PER_MINUTE * MINUTES_PER_DAY);
    expect(MILLISECONDS_PER_DAY).toBe(86_400_000);
  });

  it('曜日は 0（日）〜 6（土）の 7 種類である', () => {
    expect(DAYS_PER_WEEK).toBe(7);
    expect(DAY_OF_WEEK_MIN).toBe(0);
    expect(DAY_OF_WEEK_MAX).toBe(DAYS_PER_WEEK - 1);
  });

  it('閉店間近の閾値は 30 分である', () => {
    expect(CLOSING_SOON_THRESHOLD_MINUTES).toBe(30);
  });
});

describe('ドメインの範囲定数', () => {
  it('予算は 0 円から 100 万円までを扱う', () => {
    expect(BUDGET_YEN_MIN).toBe(0);
    expect(BUDGET_YEN_MAX).toBe(1_000_000);
  });
});
