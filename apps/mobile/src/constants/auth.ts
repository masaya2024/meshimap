import type { Role } from '@meshimap/core';
import type { Href } from 'expo-router';

/**
 * SecureStore に保存されるキーの接頭辞。
 * @better-auth/expo は `<prefix>_cookie` と `<prefix>_session_data` の 2 キーを作る
 * （node_modules/@better-auth/expo/dist/client.js の cookieName / localCacheName）。
 * 既定の 'better-auth' のままだと他アプリと衝突しうるのでアプリ名を含める。
 */
export const AUTH_STORAGE_PREFIX = 'meshimap-auth';

/** app.json の expo.scheme と一致させる。ズレると expoClient が起点 URL を作れない */
export const APP_SCHEME = 'alee';

/** Better Auth のサーバ側マウントパス（Better Auth の既定値）。apps/api 側と一致させる */
export const AUTH_BASE_PATH = '/api/auth';

/** プロフィール（= ロール）を TanStack Query で保持するときのキー接頭辞 */
export const PROFILE_QUERY_KEY = ['auth', 'profile'] as const;

/**
 * プロフィール取得の自動リトライ回数。
 * 自動リトライを入れるとスプラッシュが閉じるまでの時間が伸びて体感が悪化するため 0 にし、
 * 失敗時は index.tsx の ErrorState から手動で再試行させる。
 */
export const PROFILE_QUERY_RETRY_COUNT = 0;

/** プロフィールの再取得間隔。ロールは頻繁に変わらないので長めに取る（5 分） */
export const PROFILE_QUERY_STALE_TIME_MS = 5 * 60 * 1000;

export const ROOT_ROUTE: Href = '/';
export const WELCOME_ROUTE: Href = '/welcome';
export const SIGN_IN_ROUTE: Href = '/sign-in';
export const SIGN_UP_ROUTE: Href = '/sign-up';
export const VERIFY_EMAIL_ROUTE: Href = '/verify-email';
export const FORGOT_PASSWORD_ROUTE: Href = '/forgot-password';
export const SHOP_APPLICATION_ROUTE: Href = '/settings/shop-application';
export const OWNER_ONBOARDING_STATUS_ROUTE: Href = '/onboarding/status';

/**
 * ロールごとの着地ルート。
 * グループ名（(user) など）は URL に出ないためパスには含めない
 * （https://docs.expo.dev/router/advanced/shared-routes/）。
 */
export const ROLE_HOME_ROUTES: Record<Role, Href> = {
  user: '/home',
  owner: '/dashboard',
  admin: '/overview',
};
