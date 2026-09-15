/**
 * D1 スキーマが参照する定数。
 *
 * ここに置いている理由:
 * ロール定義とドメイン定数は本来 `@meshimap/core` の責務だが（設計書 §7）、
 * Phase 2 で core を並行実装中のため、Phase 3 では api 側に閉じた定義を持つ。
 *
 * TODO(Phase 4): `@meshimap/core` の `ROLES` / `RATING_MIN` などが確定したら、
 * このファイルは core からの再エクスポートに置き換える。その際、
 * **値が 1 文字でも違うと既存データの CHECK 制約に違反する**ため、
 * 移行時は必ず `constants.test.ts` の期待値と突き合わせること。
 */

// ───────────────────────── ロール（設計書 §4）─────────────────────────

/** 利用者。検索・レビュー・予約・通報ができる */
export const ROLE_USER = 'user';
/** 店舗管理者。自店舗の編集と予約承認ができる */
export const ROLE_OWNER = 'owner';
/** システム管理者。審査・通報対応・マスタ管理ができる */
export const ROLE_ADMIN = 'admin';

/** 1 アカウント 1 ロール。user → owner の昇格のみ実装する（設計書 §4） */
export const ROLES = [ROLE_USER, ROLE_OWNER, ROLE_ADMIN] as const;
export type Role = (typeof ROLES)[number];

// ───────────────────── プロフィールの状態 ─────────────────────

/** 通常利用できる */
export const PROFILE_STATUS_ACTIVE = 'active';
/** 管理者が停止した。ログインは通るが投稿系の操作を拒否する */
export const PROFILE_STATUS_SUSPENDED = 'suspended';
/** 退会済み。表示名を伏せるが、投稿の親子関係を壊さないよう行は残す */
export const PROFILE_STATUS_DELETED = 'deleted';

export const PROFILE_STATUSES = [
  PROFILE_STATUS_ACTIVE,
  PROFILE_STATUS_SUSPENDED,
  PROFILE_STATUS_DELETED,
] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

// ───────────────────────── 店舗の公開状態 ─────────────────────────

/** オーナーが編集中。一般利用者には見えない */
export const SHOP_STATUS_DRAFT = 'draft';
/** 申請済みで管理者の審査待ち */
export const SHOP_STATUS_PENDING = 'pending';
/** 公開中。検索・地図に出るのはこれだけ */
export const SHOP_STATUS_PUBLISHED = 'published';
/** 管理者が強制非公開にした（通報対応など） */
export const SHOP_STATUS_SUSPENDED = 'suspended';
/** 閉店。履歴としては残すが検索には出さない */
export const SHOP_STATUS_CLOSED = 'closed';

export const SHOP_STATUSES = [
  SHOP_STATUS_DRAFT,
  SHOP_STATUS_PENDING,
  SHOP_STATUS_PUBLISHED,
  SHOP_STATUS_SUSPENDED,
  SHOP_STATUS_CLOSED,
] as const;
export type ShopStatus = (typeof SHOP_STATUSES)[number];

// ───────────────────────── 予約の状態 ─────────────────────────

/** 利用者が申し込み、店舗の承認待ち */
export const RESERVATION_STATUS_PENDING = 'pending';
/** 店舗が承認した */
export const RESERVATION_STATUS_CONFIRMED = 'confirmed';
/** 店舗が拒否した */
export const RESERVATION_STATUS_REJECTED = 'rejected';
/** 利用者が取り消した */
export const RESERVATION_STATUS_CANCELLED = 'cancelled';
/** 来店が完了した */
export const RESERVATION_STATUS_COMPLETED = 'completed';
/** 無断キャンセル。completed と区別して集計するため別値にする */
export const RESERVATION_STATUS_NO_SHOW = 'no_show';

export const RESERVATION_STATUSES = [
  RESERVATION_STATUS_PENDING,
  RESERVATION_STATUS_CONFIRMED,
  RESERVATION_STATUS_REJECTED,
  RESERVATION_STATUS_CANCELLED,
  RESERVATION_STATUS_COMPLETED,
  RESERVATION_STATUS_NO_SHOW,
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** 席を実際に占有する状態。空き枠計算（Phase 7）はこの 2 つだけを数える */
export const RESERVATION_STATUSES_OCCUPYING_SEAT = [
  RESERVATION_STATUS_PENDING,
  RESERVATION_STATUS_CONFIRMED,
] as const;

// ───────────────────────── レビューの状態 ─────────────────────────

/** 公開中。評価集計の対象はこれだけ */
export const REVIEW_STATUS_PUBLISHED = 'published';
/** 管理者が非表示にした。集計から外すが行は残す */
export const REVIEW_STATUS_HIDDEN = 'hidden';
/** 投稿者が削除した */
export const REVIEW_STATUS_DELETED = 'deleted';

export const REVIEW_STATUSES = [
  REVIEW_STATUS_PUBLISHED,
  REVIEW_STATUS_HIDDEN,
  REVIEW_STATUS_DELETED,
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

// ───────────────────────── 通報 ─────────────────────────

/** 未対応 */
export const REPORT_STATUS_OPEN = 'open';
/** 管理者が確認中 */
export const REPORT_STATUS_IN_REVIEW = 'in_review';
/** 対処した（非表示・警告など） */
export const REPORT_STATUS_RESOLVED = 'resolved';
/** 問題なしとして却下した */
export const REPORT_STATUS_REJECTED = 'rejected';

export const REPORT_STATUSES = [
  REPORT_STATUS_OPEN,
  REPORT_STATUS_IN_REVIEW,
  REPORT_STATUS_RESOLVED,
  REPORT_STATUS_REJECTED,
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** 通報対象。設計書 5.1 の `report/[targetType]/[targetId]` と一致させる */
export const REPORT_TARGET_TYPE_SHOP = 'shop';
export const REPORT_TARGET_TYPE_REVIEW = 'review';
export const REPORT_TARGET_TYPE_USER = 'user';

export const REPORT_TARGET_TYPES = [
  REPORT_TARGET_TYPE_SHOP,
  REPORT_TARGET_TYPE_REVIEW,
  REPORT_TARGET_TYPE_USER,
] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

// ───────────────────────── 店舗申請 ─────────────────────────

/** 審査待ち */
export const APPLICATION_STATUS_PENDING = 'pending';
/** 承認。ここで申請者のロールが user → owner へ昇格する */
export const APPLICATION_STATUS_APPROVED = 'approved';
/** 却下。再申請はできない */
export const APPLICATION_STATUS_REJECTED = 'rejected';
/** 差し戻し。理由を添えて再提出させる（設計書 5.1 `onboarding/status.tsx`） */
export const APPLICATION_STATUS_RETURNED = 'returned';

export const APPLICATION_STATUSES = [
  APPLICATION_STATUS_PENDING,
  APPLICATION_STATUS_APPROVED,
  APPLICATION_STATUS_REJECTED,
  APPLICATION_STATUS_RETURNED,
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

// ───────────────────────── 通知 ─────────────────────────

export const NOTIFICATION_TYPE_RESERVATION_REQUESTED = 'reservation_requested';
export const NOTIFICATION_TYPE_RESERVATION_CONFIRMED = 'reservation_confirmed';
export const NOTIFICATION_TYPE_RESERVATION_REJECTED = 'reservation_rejected';
export const NOTIFICATION_TYPE_RESERVATION_CANCELLED = 'reservation_cancelled';
export const NOTIFICATION_TYPE_REVIEW_POSTED = 'review_posted';
export const NOTIFICATION_TYPE_REVIEW_REPLIED = 'review_replied';
export const NOTIFICATION_TYPE_APPLICATION_APPROVED = 'application_approved';
export const NOTIFICATION_TYPE_APPLICATION_REJECTED = 'application_rejected';
export const NOTIFICATION_TYPE_APPLICATION_RETURNED = 'application_returned';
export const NOTIFICATION_TYPE_ANNOUNCEMENT = 'announcement';

export const NOTIFICATION_TYPES = [
  NOTIFICATION_TYPE_RESERVATION_REQUESTED,
  NOTIFICATION_TYPE_RESERVATION_CONFIRMED,
  NOTIFICATION_TYPE_RESERVATION_REJECTED,
  NOTIFICATION_TYPE_RESERVATION_CANCELLED,
  NOTIFICATION_TYPE_REVIEW_POSTED,
  NOTIFICATION_TYPE_REVIEW_REPLIED,
  NOTIFICATION_TYPE_APPLICATION_APPROVED,
  NOTIFICATION_TYPE_APPLICATION_REJECTED,
  NOTIFICATION_TYPE_APPLICATION_RETURNED,
  NOTIFICATION_TYPE_ANNOUNCEMENT,
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

// ──────────────────── 数値範囲（CHECK 制約に埋め込む）────────────────────
//
// 注意: ここの値は `@meshimap/core` の同名定数と **手で同期** する。
// core を import しないのは、D1 のマイグレーション生成が core のビルドに依存すると
// 「core が壊れているとマイグレーションが生成できない」という結合を生むため。
// 値がずれた場合は Task 3-14 の突き合わせで検出する。

/** 評価の下限（星 1） */
export const RATING_MIN = 1;
/** 評価の上限（星 5） */
export const RATING_MAX = 5;

/** 平均評価の下限。レビュー 0 件のときは 0 を入れるため RATING_MIN より小さい */
export const RATING_AVG_MIN = 0;
/** 平均評価の上限 */
export const RATING_AVG_MAX = 5;

/** 曜日。0 = 日曜（JavaScript の Date#getDay と合わせる） */
export const DAY_OF_WEEK_MIN = 0;
/** 曜日。6 = 土曜 */
export const DAY_OF_WEEK_MAX = 6;

/** 1 日の分数。日跨ぎ営業はこれを超える値で表す（設計書 §6） */
export const MINUTES_PER_DAY = 1440;
/** 営業時間の下限（00:00） */
export const MINUTE_OF_DAY_MIN = 0;
/** 営業時間の上限（翌 23:59）。1440 + 1439 = 2879 */
export const MINUTE_OF_DAY_MAX = 2879;

/** 予約人数の下限 */
export const PARTY_SIZE_MIN = 1;
/** 予約人数の上限。これを超える団体は電話で受ける想定 */
export const PARTY_SIZE_MAX = 20;

/** 予算（円）の下限 */
export const BUDGET_YEN_MIN = 0;
/** 予算（円）の上限。100 万円を超える入力は誤りとみなす */
export const BUDGET_YEN_MAX = 1_000_000;

/** 予約枠の長さ（分）の下限 */
export const SLOT_MINUTES_MIN = 15;
/** 予約枠の長さ（分）の上限 */
export const SLOT_MINUTES_MAX = 240;

/** 席数の下限 */
export const SEAT_CAPACITY_MIN = 1;
/** 席数の上限 */
export const SEAT_CAPACITY_MAX = 500;

/** 同時受付枠数の下限 */
export const MAX_PARALLEL_MIN = 1;
/** 同時受付枠数の上限 */
export const MAX_PARALLEL_MAX = 100;

/** 緯度の下限 */
export const LATITUDE_MIN = -90;
/** 緯度の上限 */
export const LATITUDE_MAX = 90;
/** 経度の下限 */
export const LONGITUDE_MIN = -180;
/** 経度の上限 */
export const LONGITUDE_MAX = 180;

/**
 * `shops.geohash` に格納する precision。
 * 設計書 §3.1 より precision 7 は約 152m 四方。徒歩圏（〜1km）の検索で
 * 候補が数十件に収まる粒度。検索時はこれを半径に応じて前方から切り詰めて使う。
 */
export const SHOP_GEOHASH_PRECISION = 7;

/** 並び順の下限。負値は許さない */
export const SORT_ORDER_MIN = 0;

/** 価格（円）の下限 */
export const PRICE_YEN_MIN = 0;
/** 価格（円）の上限 */
export const PRICE_YEN_MAX = 1_000_000;

/** 閲覧数などのカウンタの下限 */
export const COUNT_MIN = 0;

// ──────────────────── 文字列長（CHECK 制約に埋め込む）────────────────────

/** 店名 */
export const SHOP_NAME_MAX_LENGTH = 100;
/** 店名（かな） */
export const SHOP_NAME_KANA_MAX_LENGTH = 200;
/** 住所 */
export const SHOP_ADDRESS_MAX_LENGTH = 200;
/** 店舗説明 */
export const SHOP_DESCRIPTION_MAX_LENGTH = 2000;
/** レビュー本文 */
export const REVIEW_BODY_MAX_LENGTH = 2000;
/** 予約時の要望 */
export const RESERVATION_NOTE_MAX_LENGTH = 500;
/** 主キーなどの識別子。ULID / UUID / スラッグをまとめて収める長さ */
export const IDENTIFIER_MAX_LENGTH = 64;

/**
 * R2 オブジェクトキーの上限。`<種別>/<id>/<uuid>.<ext>`（規約 §1.2）が収まる長さ。
 * shop_photos / review_photos / menu_items の 3 箇所で使うのでここに置く。
 */
export const R2_KEY_MAX_LENGTH = 200;
/** R2 オブジェクトキーに使える文字。`/` `.` `-` と小文字英数字のみ */
export const R2_KEY_ALLOWED_CHARACTERS = 'a-z0-9/._-';

// ──────────────────── GLOB パターン（CHECK 制約に埋め込む）────────────────────

/**
 * ISO 8601 の日付（YYYY-MM-DD）を表す GLOB パターン。
 * SQLite の GLOB に `\d` はなく `[0-9]` を桁数ぶん並べるしかない。
 * shop_closures.date と reviews.visited_on の 2 箇所で使うのでここに置く。
 *
 * 桁の形しか見ないため 2026-13-45 のような日付は通る。実在する日付かどうかは
 * アプリ側（Zod スキーマ）で検証する。DB では「形が違うものを入れさせない」までを担う。
 */
export const ISO_DATE_GLOB_PATTERN = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]';
