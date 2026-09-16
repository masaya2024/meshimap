import { Hono } from 'hono';
import { AUTH_BASE_PATH, createAuth } from './auth/auth';
import { createDatabase } from './db/client';
import type { AppBindings, AppEnv } from './lib/app-env';
import { authMiddleware } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { meRoutes } from './routes/me';
import { reviewRoutes } from './routes/reviews';
import { shopRoutes } from './routes/shops';

/**
 * ルートの登録順には意味がある。
 * 1. onError / notFound を先に付ける（以降のどこで投げても同じ形の JSON になる）
 * 2. Better Auth のハンドラ（authMiddleware より前。セッション発行自体は未認証で行う）
 * 3. authMiddleware（以降すべてのハンドラで c.get('viewer') が使える）
 * 4. 各ルートグループ
 *
 * メソッドチェーンを途中で変数に切らないこと。切ると型が積み上がらず AppType が痩せる。
 */
export const app = new Hono<AppEnv>()
  .onError(errorHandler)
  .notFound(notFoundHandler)
  .on(['GET', 'POST'], `${AUTH_BASE_PATH}/*`, (c) => {
    const auth = createAuth(createDatabase(c.env.DB), c.env);
    return auth.handler(c.req.raw);
  })
  .use('*', authMiddleware)
  .get('/health', (c) => c.json({ status: 'ok' as const }))
  .route('/me', meRoutes)
  .route('/shops', shopRoutes)
  .route('/reviews', reviewRoutes);

/** モバイル側が `hc<AppType>` で使う型。ここを export しないと RPC の型が付かない */
export type AppType = typeof app;

/**
 * Phase 7（予約）で実装する。
 * wrangler.jsonc の durable_objects バインディング（RESERVATION_LOCK → ReservationLock）と
 * migrations[0].new_sqlite_classes がこのクラスの export を要求するため、空の実体を先に置く。
 * 置かないと `wrangler dev` が「Class ReservationLock not found」で起動しない。
 *
 * `cloudflare:workers` の DurableObject 基底クラスを継承しない。
 * 継承すると index.ts が workerd 専用モジュールに依存し、Node で走る routes.test.ts が
 * `Cannot find module 'cloudflare:workers'` で読み込めなくなる（実測済み）。
 * 旧来形式（コンストラクタで state と env を受ける普通のクラス）でも
 * new_sqlite_classes と組み合わせて動くことは miniflare 上で確認済み。
 * DurableObject / DurableObjectState は @cloudflare/workers-types のグローバル型なので import は要らない。
 */
export class ReservationLock implements DurableObject {
  // Phase 7 で state.storage.sql を使う。今は受け取るだけで保持しない
  constructor(_state: DurableObjectState, _env: AppBindings) {}

  // await するものが無いので async にしない（@typescript-eslint/require-await）。
  // DurableObject#fetch の戻りは Response | Promise<Response> なので同期で返してよい
  fetch(_request: Request): Response {
    return new Response('Not Implemented', { status: 501 });
  }
}

// Workers のモジュールワーカーは default export を要求する。
// CODING_GUIDELINES 2 章のデフォルトエクスポート禁止に対する、プラットフォーム上の唯一の例外。
// eslint-disable-next-line no-restricted-syntax -- Workers ランタイムが default export を必須とするため
export default app;
