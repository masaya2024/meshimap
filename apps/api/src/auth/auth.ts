import { expo } from '@better-auth/expo';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { PROFILE_STATUS_ACTIVE, ROLE_USER } from '../db/constants';
import { account, profiles, session, user, verification } from '../db/schema';
import { PROFILE_DISPLAY_NAME_MAX_LENGTH } from '../lib/constants';
import type { Database } from '../db/client';
import type { AppBindings } from '../lib/app-env';

/** Hono 側の `app.on(['GET', 'POST'], '/api/auth/*', ...)` と一致させる */
export const AUTH_BASE_PATH = '/api/auth';

/**
 * createAuth が実際に読むバインディングだけを要求する。
 * AppBindings 全体を要求すると、テストで R2 / KV / Durable Object のダミーを
 * `as` で捏造する必要が出る。必要な 3 つに絞れば `as` なしで呼べる。
 * AppBindings はこの型を構造的に満たすので、本番の呼び出し側は何も変えなくてよい。
 */
export type AuthBindings = Pick<
  AppBindings,
  'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL' | 'MOBILE_APP_SCHEME'
>;

/**
 * Better Auth のインスタンスを作る。
 * Workers では env がリクエストごとなので、リクエスト単位で生成する。
 *
 * セッションは Cookie で運ぶ。Expo クライアント（@better-auth/expo）は
 * set-cookie を SecureStore に保存して Cookie ヘッダで送り返す実装なので、
 * bearer プラグインは不要（Bearer だけでは getSession が null になることを実測済み）。
 */
export function createAuth(db: Database, env: AuthBindings) {
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      // Better Auth が触ってよいのはこの 4 テーブルだけ。profiles は渡さない
      schema: { user, session, account, verification },
      // D1 に対話的トランザクションがないため無効化する。
      // true にすると `begin` の時点で D1_ERROR になり sign-up が 500 になる（実測済み）
      transaction: false,
    }),
    emailAndPassword: { enabled: true },
    // Expo アプリのカスタムスキームを trustedOrigins に加え、認可プロキシを生やす
    plugins: [expo()],
    // `://` まで含めないと better-auth の parseCustomSchemeOrigin が null を返して一致しない
    trustedOrigins: [`${env.MOBILE_APP_SCHEME}://`],
    // Worker から外部への送信を発生させない
    telemetry: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          /**
           * Better Auth は user しか作らないため、アプリ側のロールを持つ profiles をここで作る。
           * これが無いと Task 4-6 の loadActor が常に null になり、
           * サインアップ直後のユーザーが全 API で 401 になる。
           * 新規ユーザーのロールは常に user。owner への昇格は店舗申請の審査を通す（設計書 §4）。
           */
          after: async (createdUser) => {
            await db.insert(profiles).values({
              userId: createdUser.id,
              role: ROLE_USER,
              // CHECK(length(display_name) <= 50) を満たすため切り詰める
              displayName: createdUser.name.slice(0, PROFILE_DISPLAY_NAME_MAX_LENGTH),
              status: PROFILE_STATUS_ACTIVE,
              // Better Auth の User.createdAt は Date。
              // profiles.created_at は mode: 'timestamp_ms' なので Date のまま渡す
              createdAt: createdUser.createdAt,
            });
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
