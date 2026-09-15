import { describe, expect, it } from 'vitest';
import {
  IDENTIFIER_MAX_LENGTH,
  toReservationId,
  toReviewId,
  toShopId,
  toUserId,
} from './identifier';

describe('IDENTIFIER_MAX_LENGTH', () => {
  it('ID の最大長は 64 文字である', () => {
    expect(IDENTIFIER_MAX_LENGTH).toBe(64);
  });
});

describe('toShopId', () => {
  it('英数字・ハイフン・アンダースコアの ID をそのまま返す', () => {
    expect(toShopId('shop_1-A')).toBe('shop_1-A');
  });

  it('1 文字の ID を受け入れる', () => {
    expect(toShopId('a')).toBe('a');
  });

  it('上限ちょうど 64 文字を受け入れる', () => {
    const value = 'a'.repeat(IDENTIFIER_MAX_LENGTH);
    expect(toShopId(value)).toBe(value);
  });

  it('空文字を拒否する', () => {
    expect(() => toShopId('')).toThrow(
      new RangeError('店舗 ID の長さは 1 〜 64 文字である必要があります: ""'),
    );
  });

  it('上限を 1 文字超えた値を拒否する', () => {
    const value = 'a'.repeat(IDENTIFIER_MAX_LENGTH + 1);
    expect(() => toShopId(value)).toThrow(
      new RangeError(`店舗 ID の長さは 1 〜 64 文字である必要があります: "${value}"`),
    );
  });

  it('日本語を含む値を拒否する', () => {
    expect(() => toShopId('店1')).toThrow(
      new RangeError('店舗 ID に使用できない文字が含まれています: "店1"'),
    );
  });

  it('空白を含む値を拒否する', () => {
    expect(() => toShopId('shop 1')).toThrow(
      new RangeError('店舗 ID に使用できない文字が含まれています: "shop 1"'),
    );
  });

  it('SQL のワイルドカードを含む値を拒否する', () => {
    expect(() => toShopId("shop';--")).toThrow(
      new RangeError('店舗 ID に使用できない文字が含まれています: "shop\';--"'),
    );
  });
});

describe('toUserId / toReviewId / toReservationId', () => {
  it('それぞれ正しい値をそのまま返す', () => {
    expect(toUserId('user_1')).toBe('user_1');
    expect(toReviewId('review_1')).toBe('review_1');
    expect(toReservationId('reservation_1')).toBe('reservation_1');
  });

  it('エラーメッセージに種別名が入る', () => {
    expect(() => toUserId('')).toThrow(
      new RangeError('ユーザー ID の長さは 1 〜 64 文字である必要があります: ""'),
    );
    expect(() => toReviewId('')).toThrow(
      new RangeError('レビュー ID の長さは 1 〜 64 文字である必要があります: ""'),
    );
    expect(() => toReservationId('')).toThrow(
      new RangeError('予約 ID の長さは 1 〜 64 文字である必要があります: ""'),
    );
  });

  it('不正文字のエラーメッセージにも種別名が入る', () => {
    expect(() => toUserId('ユーザー')).toThrow(
      new RangeError('ユーザー ID に使用できない文字が含まれています: "ユーザー"'),
    );
    expect(() => toReviewId('レビュー')).toThrow(
      new RangeError('レビュー ID に使用できない文字が含まれています: "レビュー"'),
    );
    expect(() => toReservationId('予約')).toThrow(
      new RangeError('予約 ID に使用できない文字が含まれています: "予約"'),
    );
  });
});
