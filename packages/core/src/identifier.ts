// 各テーブルの ID をブランド型で区別する。shop_id を user_id の位置に渡す事故をコンパイル時に防ぐ。

declare const shopIdBrand: unique symbol;
declare const userIdBrand: unique symbol;
declare const reviewIdBrand: unique symbol;
declare const reservationIdBrand: unique symbol;

export type ShopId = string & { readonly [shopIdBrand]: true };
export type UserId = string & { readonly [userIdBrand]: true };
export type ReviewId = string & { readonly [reviewIdBrand]: true };
export type ReservationId = string & { readonly [reservationIdBrand]: true };

/** ID の最大長。D1 の TEXT 列に入る現実的な上限。 */
export const IDENTIFIER_MAX_LENGTH = 64;

/** URL とファイル名に安全な文字だけを許可し、SQL やパスの事故を防ぐ。 */
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 4 つの ID で共通の検証。ラベルだけ差し替えてメッセージを具体的にする。 */
function assertIdentifier(label: string, value: string): void {
  if (value.length === 0 || value.length > IDENTIFIER_MAX_LENGTH) {
    throw new RangeError(
      `${label} の長さは 1 〜 ${IDENTIFIER_MAX_LENGTH} 文字である必要があります: "${value}"`,
    );
  }
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new RangeError(`${label} に使用できない文字が含まれています: "${value}"`);
  }
}

export function toShopId(value: string): ShopId {
  assertIdentifier('店舗 ID', value);
  // ブランド型の生成点。ここ以外で as は使わない
  return value as ShopId;
}

export function toUserId(value: string): UserId {
  assertIdentifier('ユーザー ID', value);
  return value as UserId;
}

export function toReviewId(value: string): ReviewId {
  assertIdentifier('レビュー ID', value);
  return value as ReviewId;
}

export function toReservationId(value: string): ReservationId {
  assertIdentifier('予約 ID', value);
  return value as ReservationId;
}
