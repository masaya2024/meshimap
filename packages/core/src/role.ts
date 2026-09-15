// 利用者 / 店舗管理者 / システム管理者の 3 ロールと、その権限判定。

/** 一般利用者。店舗を探して予約・レビューする。 */
export const ROLE_USER = 'user';
/** 店舗管理者。自店舗の情報と予約を管理する。 */
export const ROLE_OWNER = 'owner';
/** システム管理者。全店舗の管理と通報対応を行う。 */
export const ROLE_ADMIN = 'admin';

/** 権限の弱い順に並べる。UI の選択肢もこの順で表示する。 */
export const ROLES = [ROLE_USER, ROLE_OWNER, ROLE_ADMIN] as const;

export type Role = (typeof ROLES)[number];

/** D1 やリクエストから来た未検証の値を Role に絞り込む。 */
export function isRole(value: unknown): value is Role {
  // 文字列以外は === で一致しないので typeof の事前判定は要らない
  return ROLES.some((role) => role === value);
}

/** Role でなければ例外にする。API 境界で不正なロールを持ち込ませないため。 */
export function toRole(value: unknown): Role {
  if (!isRole(value)) {
    throw new RangeError(`未知のロールです: ${JSON.stringify(value)}`);
  }
  return value;
}

/** 店舗情報の編集権限。admin は全店舗、owner は自店舗（所有者判定は呼び出し側の責務）。 */
export function canManageShop(role: Role): boolean {
  return role === ROLE_OWNER || role === ROLE_ADMIN;
}

/** レビューの非公開化など、モデレーション権限。 */
export function canModerate(role: Role): boolean {
  return role === ROLE_ADMIN;
}
