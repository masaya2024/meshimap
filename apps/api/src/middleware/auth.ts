import { createMiddleware } from 'hono/factory';
import { ANONYMOUS_VIEWER } from '../auth/actor';
import { createAuth } from '../auth/auth';
import { loadActor } from '../auth/load-actor';
import { createDatabase } from '../db/client';
import type { AppEnv } from '../lib/app-env';
import { forbidden } from '../lib/http-error';

/**
 * セッションを検証して Context に viewer を載せる。
 * ここが Actor の唯一の生成経路であり、以降のレイヤは viewer を信頼してよい。
 */
export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  // Cookie が無いリクエストで Better Auth を組み立てるのは無駄。
  // 公開エンドポイント（地図・検索）の方が呼び出し回数が多いので、ここで短絡させる
  if (c.req.header('cookie') === undefined) {
    c.set('viewer', ANONYMOUS_VIEWER);
    await next();
    return;
  }

  const database = createDatabase(c.env.DB);
  const auth = createAuth(database, c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });

  if (session === null) {
    // 期限切れや改竄された Cookie。エラーにせず匿名として続行する
    c.set('viewer', ANONYMOUS_VIEWER);
    await next();
    return;
  }

  const result = await loadActor(database, session.user.id);
  switch (result.kind) {
    case 'found':
      c.set('viewer', result.actor);
      break;
    case 'no-profile':
      // 認証は通ったがアプリ側のプロフィールが無い。権限は一切与えない
      c.set('viewer', ANONYMOUS_VIEWER);
      break;
    case 'suspended':
    case 'invalid-role':
      // ロール単位の拒否。リソース ID に依存しないので存在有無は漏れない
      throw forbidden();
  }

  await next();
});
