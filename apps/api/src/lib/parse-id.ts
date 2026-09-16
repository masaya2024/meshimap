import { toReviewId, toShopId } from '@meshimap/core';
import type { ReviewId, ShopId } from '@meshimap/core';
import { notFound } from './http-error';

/**
 * 形式が不正な ID は「存在しない ID」と同じ 404 にする。
 * 422 を返すと「形式は正しいが存在しない」との差から ID の書式が推測できてしまう。
 */
export function parseShopId(value: string): ShopId {
  try {
    return toShopId(value);
  } catch {
    // toShopId は RangeError を投げる（packages/core/src/identifier.ts）。握り潰して 404 に寄せる
    throw notFound();
  }
}

export function parseReviewId(value: string): ReviewId {
  try {
    return toReviewId(value);
  } catch {
    throw notFound();
  }
}

/**
 * ID はサーバで採番する。クライアントに決めさせると、既存 ID との衝突を試して
 * 存在有無を探れる（衝突時のエラーが情報になる）。
 * crypto.randomUUID はハイフンを含むが IDENTIFIER_PATTERN が許容する文字種。
 * 接頭辞 4 文字 + UUID 36 文字 = 40 文字で IDENTIFIER_MAX_LENGTH（64）に収まる。
 */
export function generateShopId(): ShopId {
  return toShopId(`shp_${crypto.randomUUID()}`);
}

export function generateReviewId(): ReviewId {
  return toReviewId(`rev_${crypto.randomUUID()}`);
}
