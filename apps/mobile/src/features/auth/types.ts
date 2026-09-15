import type { Role, UserId } from '@meshimap/core';

/**
 * アプリ全体が参照する唯一の認証状態。
 * 「復元中」を独立した状態として持たせるのが要点で、
 * これが無いと復元中の未認証（= セッションがまだ読めていない）と
 * 本当の未認証を区別できず、起動直後にログイン画面がちらつく。
 */
export type AuthState =
  /** SecureStore からのセッション復元、またはプロフィール取得が進行中 */
  | { status: 'restoring' }
  /** セッションが無い。(auth) グループのみ到達できる */
  | { status: 'unauthenticated' }
  /** セッションはあるがロールが取れない。ロールが決まらない以上どのグループにも入れない */
  | { status: 'profile-unavailable'; retry: () => void }
  /** セッションとロールが揃った */
  | { status: 'authenticated'; userId: UserId; role: Role; displayName: string };
