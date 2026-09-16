import type { Viewer } from '../auth/actor';

/** wrangler.jsonc のバインディングと、secret で注入する値 */
export type AppBindings = {
  readonly DB: D1Database;
  readonly MEDIA: R2Bucket;
  readonly CACHE: KVNamespace;
  /**
   * 予約の同時押さえを防ぐ Durable Object。Phase 7 で本実装する。
   * wrangler.jsonc に既にバインディングが書かれているので、Phase 4 の時点で型に含めておく。
   * 含めないと index.ts の DurableObject<AppBindings> が env の型と食い違う。
   */
  readonly RESERVATION_LOCK: DurableObjectNamespace;
  /** Better Auth の署名鍵。`wrangler secret put BETTER_AUTH_SECRET` で設定する */
  readonly BETTER_AUTH_SECRET: string;
  /** Better Auth の baseURL。ローカルは http://localhost:8787 */
  readonly BETTER_AUTH_URL: string;
  /** Expo アプリのカスタムスキーム。trustedOrigins に渡す */
  readonly MOBILE_APP_SCHEME: string;
};

/**
 * Context に載せる値。
 * viewer は未認証（AnonymousActor）も含むため、認証必須の処理では必ず絞り込む。
 */
export type AppVariables = {
  readonly viewer: Viewer;
};

export type AppEnv = { Bindings: AppBindings; Variables: AppVariables };
