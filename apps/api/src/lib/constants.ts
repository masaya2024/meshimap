/**
 * API 層だけで使う定数。
 *
 * ロール（`ROLE_*`）と状態値（`SHOP_STATUS_*` / `REVIEW_STATUS_*` / `PROFILE_STATUS_*`）、
 * および `SHOP_GEOHASH_PRECISION` は `src/db/constants.ts` が唯一の定義元。
 * ここには再定義も再 export もしない。
 * 再 export すると「どちらから import しても良い」状態になり、
 * 片方だけ直したときに値がずれても型では気づけなくなるため。
 */

/** 店舗一覧の既定件数。1 画面に収まる量として設定する */
export const SHOP_LIST_DEFAULT_LIMIT = 20;

/** 店舗一覧で許容する最大件数。無制限にすると Worker の CPU 時間を食い潰す */
export const SHOP_LIST_MAX_LIMIT = 100;

/** レビュー一覧の既定件数 */
export const REVIEW_LIST_DEFAULT_LIMIT = 20;

/** レビュー一覧で許容する最大件数 */
export const REVIEW_LIST_MAX_LIMIT = 100;

/**
 * `profiles.display_name` の上限。
 *
 * 値の定義元は `src/db/schema/master.ts` の `DISPLAY_NAME_MAX_LENGTH` だが、
 * あちらは module-private で export されていないため import できない（実ファイルで確認済み）。
 * `migrations/0000_init.sql` の `ck_profiles_display_name_length` にも同じ値が焼かれている。
 * Task 4-5 でサインアップ時に profiles を自動作成する際、Better Auth の `user.name` を
 * この長さに切り詰めないと CHECK 制約違反でサインアップ全体が 500 になるため、写しをここに置く。
 * ズレは `src/db/constants-parity.test.ts` がマイグレーション本文と突き合わせて検出する。
 */
export const PROFILE_DISPLAY_NAME_MAX_LENGTH = 50;
