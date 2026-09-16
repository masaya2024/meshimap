import { ROLE_ADMIN, ROLE_OWNER, ROLE_USER } from '@meshimap/core';
import type { Role } from '@meshimap/core';
import { createMiddleware } from 'hono/factory';
import type { Context, MiddlewareHandler } from 'hono';
import { isAdminActor, isAuthenticatedActor, isOwnerActor, isUserActor } from '../auth/actor';
import type { Actor, AdminActor, OwnerActor, UserActor, Viewer } from '../auth/actor';
import type { AppEnv } from '../lib/app-env';
import { forbidden, unauthorized } from '../lib/http-error';

/** ロール名からその判定関数を引く表。switch を各所に散らさないため */
const ROLE_PREDICATES: Record<Role, (viewer: Viewer) => boolean> = {
  [ROLE_USER]: isUserActor,
  [ROLE_OWNER]: isOwnerActor,
  [ROLE_ADMIN]: isAdminActor,
};

/**
 * ルートグループ単位の門番。
 * 未認証は 401、ロール不一致は 403。403 はリソース ID を見る前に返すので存在有無が漏れない。
 * admin を暗黙に通す特例は作らない（必要なら呼び出し側で ROLE_ADMIN を明示する）。
 */
export function roleGuard(...allowedRoles: readonly Role[]): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const viewer = c.get('viewer');
    if (!isAuthenticatedActor(viewer)) {
      throw unauthorized();
    }
    const isAllowed = allowedRoles.some((role) => ROLE_PREDICATES[role](viewer));
    if (!isAllowed) {
      throw forbidden();
    }
    await next();
  });
}

/**
 * ハンドラ内で Viewer を具体的な Actor 型へ絞り込む。
 * Hono の Variables 型は後段で狭められないため、リポジトリ関数へ渡すにはこの関数が要る。
 * roleGuard を付け忘れても同じ 403 を投げるので、二重の防御になる。
 */
export function requireUserActor(c: Context<AppEnv>): UserActor {
  const viewer = c.get('viewer');
  if (!isAuthenticatedActor(viewer)) {
    throw unauthorized();
  }
  if (!isUserActor(viewer)) {
    throw forbidden();
  }
  return viewer;
}

export function requireOwnerActor(c: Context<AppEnv>): OwnerActor {
  const viewer = c.get('viewer');
  if (!isAuthenticatedActor(viewer)) {
    throw unauthorized();
  }
  if (!isOwnerActor(viewer)) {
    throw forbidden();
  }
  return viewer;
}

export function requireAdminActor(c: Context<AppEnv>): AdminActor {
  const viewer = c.get('viewer');
  if (!isAuthenticatedActor(viewer)) {
    throw unauthorized();
  }
  if (!isAdminActor(viewer)) {
    throw forbidden();
  }
  return viewer;
}

/** ロールを問わず「ログインしていること」だけを要求する */
export function requireActor(c: Context<AppEnv>): Actor {
  const viewer = c.get('viewer');
  if (!isAuthenticatedActor(viewer)) {
    throw unauthorized();
  }
  return viewer;
}
