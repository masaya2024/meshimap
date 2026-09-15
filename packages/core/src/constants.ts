// ドメイン全体で共有する定数。マジックナンバーをコードに直接書かないための唯一の置き場。

/** 1 時間 = 60 分。 */
export const MINUTES_PER_HOUR = 60;
/** 1 日 = 1440 分。日跨ぎ営業の判定はこの値を境にする。 */
export const MINUTES_PER_DAY = 1440;
/** 0 時からの分の下限。 */
export const MINUTE_OF_DAY_MIN = 0;
/** 0 時からの分の上限。翌 23:59 = 2879 まで許容して日跨ぎ営業を表現する。 */
export const MINUTE_OF_DAY_MAX = 2879;
/** 1 日 = 24 時間。 */
export const HOURS_PER_DAY = 24;
/** 1 週 = 7 日。曜日の剰余計算に使う。 */
export const DAYS_PER_WEEK = 7;
/** 曜日の下限（0 = 日曜）。D1 の shop_hours.day_of_week と揃える。 */
export const DAY_OF_WEEK_MIN = 0;
/** 曜日の上限（6 = 土曜）。 */
export const DAY_OF_WEEK_MAX = 6;
/** JST は UTC+9。サーバ・端末のタイムゾーンに依存せず自前で加算するために持つ。 */
export const JST_OFFSET_MINUTES = 540;
/** 1 分 = 60000 ミリ秒。 */
export const MILLISECONDS_PER_MINUTE = 60_000;
/** 1 日 = 86400000 ミリ秒。日付の加減算に使う。 */
export const MILLISECONDS_PER_DAY = 86_400_000;
/** 閉店まで 30 分以内なら「まもなく閉店」と案内する。 */
export const CLOSING_SOON_THRESHOLD_MINUTES = 30;
/** 評価の下限（星 1）。 */
export const RATING_MIN = 1;
/** 評価の上限（星 5）。 */
export const RATING_MAX = 5;
/** 予約人数の下限。 */
export const PARTY_SIZE_MIN = 1;
/** 予約人数の上限。これを超える宴会は電話対応とする運用判断。 */
export const PARTY_SIZE_MAX = 20;
/** 予算の下限（0 円）。 */
export const BUDGET_YEN_MIN = 0;
/** 予算の上限（100 万円）。入力ミスを弾くための現実的な上限。 */
export const BUDGET_YEN_MAX = 1_000_000;
/** 店名の最大文字数。 */
export const SHOP_NAME_MAX_LENGTH = 100;
/** 店名カナの最大文字数。カナは表記が伸びるので店名の 2 倍を取る。 */
export const SHOP_NAME_KANA_MAX_LENGTH = 200;
/** 住所の最大文字数。 */
export const SHOP_ADDRESS_MAX_LENGTH = 200;
/** 店舗紹介文の最大文字数。 */
export const SHOP_DESCRIPTION_MAX_LENGTH = 2000;
/** レビュー本文の最大文字数。 */
export const REVIEW_BODY_MAX_LENGTH = 2000;
/** 予約メモの最大文字数。 */
export const RESERVATION_NOTE_MAX_LENGTH = 500;
/** 予約枠の最小長（分）。 */
export const SLOT_MINUTES_MIN = 15;
/** 予約枠の最大長（分）= 4 時間。 */
export const SLOT_MINUTES_MAX = 240;
/** 席数の下限。 */
export const SEAT_CAPACITY_MIN = 1;
/** 席数の上限。 */
export const SEAT_CAPACITY_MAX = 500;
/** 同一枠で受け付ける予約件数の下限。 */
export const MAX_PARALLEL_MIN = 1;
/** 同一枠で受け付ける予約件数の上限。 */
export const MAX_PARALLEL_MAX = 100;

/** 日跨ぎ時刻の接頭辞。「翌 1:30」のように表示する。 */
export const NEXT_DAY_PREFIX = '翌 ';
/** 開店時刻と閉店時刻の区切り。 */
export const BUSINESS_HOURS_SEPARATOR = ' - ';
/** 昼夜 2 部営業など、複数の営業帯をつなぐ区切り。 */
export const BUSINESS_HOURS_JOINER = ' / ';
/** 定休日の表示ラベル。 */
export const REGULAR_HOLIDAY_LABEL = '定休日';
