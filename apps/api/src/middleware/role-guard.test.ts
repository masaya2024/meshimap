import { ROLE_ADMIN, ROLE_OWNER, ROLE_USER } from '@meshimap/core';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../lib/app-env';
import { createTestBindings, createTestWorld, signUpAs } from '../test/fixtures';
import type { TestWorld } from '../test/fixtures';
import { authMiddleware } from './auth';
import { errorHandler } from './error-handler';
import {
  requireActor,
  requireAdminActor,
  requireOwnerActor,
  requireUserActor,
  roleGuard,
} from './role-guard';

function createGuardApp() {
  return new Hono<AppEnv>()
    .onError(errorHandler)
    .use('*', authMiddleware)
    .get('/owner-only', roleGuard(ROLE_OWNER), (c) => c.json({ ok: true }))
    .get('/admin-only', roleGuard(ROLE_ADMIN), (c) => c.json({ ok: true }))
    .get('/owner-or-admin', roleGuard(ROLE_OWNER, ROLE_ADMIN), (c) => c.json({ ok: true }))
    .get('/any-authenticated', roleGuard(ROLE_USER, ROLE_OWNER, ROLE_ADMIN), (c) =>
      c.json({ ok: true }),
    )
    .get('/require-user', (c) => c.json({ userId: requireUserActor(c).userId }))
    .get('/require-owner', (c) => c.json({ userId: requireOwnerActor(c).userId }))
    .get('/require-admin', (c) => c.json({ userId: requireAdminActor(c).userId }))
    .get('/require-actor', (c) => c.json({ role: requireActor(c).role }));
}

describe('roleGuard', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  async function get(path: string, cookie?: string): Promise<Response> {
    const headers = cookie === undefined ? {} : { cookie };
    return await createGuardApp().request(path, { headers }, createTestBindings(world));
  }

  it('未認証は 401 を返す（403 ではない）', async () => {
    const res = await get('/owner-only');
    expect(res.status).toBe(401);
  });

  it('許可ロールなら通す', async () => {
    const bob = await signUpAs(world, 'bob@example.com', ROLE_OWNER);
    const res = await get('/owner-only', bob.cookie);
    expect(res.status).toBe(200);
  });

  it('許可されていないロールは 403 を返す', async () => {
    const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
    const res = await get('/owner-only', alice.cookie);
    expect(res.status).toBe(403);
  });

  it('admin でも owner 専用ルートには入れない（暗黙の昇格をしない）', async () => {
    const carol = await signUpAs(world, 'carol@example.com', ROLE_ADMIN);
    const res = await get('/owner-only', carol.cookie);
    expect(res.status).toBe(403);
  });

  it('複数ロールを許可した場合は両方通す', async () => {
    const bob = await signUpAs(world, 'bob@example.com', ROLE_OWNER);
    const carol = await signUpAs(world, 'carol@example.com', ROLE_ADMIN);
    expect((await get('/owner-or-admin', bob.cookie)).status).toBe(200);
    expect((await get('/owner-or-admin', carol.cookie)).status).toBe(200);
  });

  it('複数ロールを許可しても、含まれないロールは 403', async () => {
    const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
    expect((await get('/owner-or-admin', alice.cookie)).status).toBe(403);
  });

  it('全ロール許可でも未認証は 401', async () => {
    expect((await get('/any-authenticated')).status).toBe(401);
  });

  it('403 の本文にロール名やルート名を含めない', async () => {
    const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
    const body = await (await get('/owner-only', alice.cookie)).text();
    expect(body).not.toContain('owner');
    expect(body).not.toContain('user');
  });
});

describe('require*Actor ヘルパ', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  async function get(path: string, cookie?: string): Promise<Response> {
    const headers = cookie === undefined ? {} : { cookie };
    return await createGuardApp().request(path, { headers }, createTestBindings(world));
  }

  it('requireUserActor は user のとき userId を返す', async () => {
    const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
    const res = await get('/require-user', alice.cookie);
    expect(await res.json()).toEqual({ userId: alice.userId });
  });

  it('requireUserActor は owner のとき 403', async () => {
    const bob = await signUpAs(world, 'bob@example.com', ROLE_OWNER);
    expect((await get('/require-user', bob.cookie)).status).toBe(403);
  });

  it('requireOwnerActor は owner のとき userId を返す', async () => {
    const bob = await signUpAs(world, 'bob@example.com', ROLE_OWNER);
    const res = await get('/require-owner', bob.cookie);
    expect(await res.json()).toEqual({ userId: bob.userId });
  });

  it('requireOwnerActor は admin のとき 403（admin 用の関数を使わせる）', async () => {
    const carol = await signUpAs(world, 'carol@example.com', ROLE_ADMIN);
    expect((await get('/require-owner', carol.cookie)).status).toBe(403);
  });

  it('requireAdminActor は admin のとき userId を返す', async () => {
    const carol = await signUpAs(world, 'carol@example.com', ROLE_ADMIN);
    const res = await get('/require-admin', carol.cookie);
    expect(await res.json()).toEqual({ userId: carol.userId });
  });

  it('requireAdminActor は user のとき 403（ロールの取り違えを検出する）', async () => {
    const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
    expect((await get('/require-admin', alice.cookie)).status).toBe(403);
  });

  it('requireAdminActor は未認証のとき 401', async () => {
    expect((await get('/require-admin')).status).toBe(401);
  });

  it('requireActor は認証済みなら全ロールで通る', async () => {
    const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
    const bob = await signUpAs(world, 'bob@example.com', ROLE_OWNER);
    const carol = await signUpAs(world, 'carol@example.com', ROLE_ADMIN);
    expect(await (await get('/require-actor', alice.cookie)).json()).toEqual({ role: ROLE_USER });
    expect(await (await get('/require-actor', bob.cookie)).json()).toEqual({ role: ROLE_OWNER });
    expect(await (await get('/require-actor', carol.cookie)).json()).toEqual({ role: ROLE_ADMIN });
  });

  it('requireActor は未認証のとき 401', async () => {
    expect((await get('/require-actor')).status).toBe(401);
  });
});
