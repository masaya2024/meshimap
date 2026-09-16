import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_ANONYMOUS } from '../auth/actor';
import { PROFILE_STATUS_SUSPENDED, ROLE_ADMIN, ROLE_OWNER, ROLE_USER } from '../db/constants';
import { ERROR_MESSAGE_FORBIDDEN } from '../lib/http-error';
import type { AppEnv } from '../lib/app-env';
import {
  corruptProfileRole,
  createTestBindings,
  createTestWorld,
  runWrite,
  signUpAs,
} from '../test/fixtures';
import type { TestWorld } from '../test/fixtures';
import { errorHandler } from './error-handler';
import { authMiddleware } from './auth';

/**
 * viewer をそのまま JSON にして返すだけのアプリ。
 * ルート側のロジックを混ぜないことで、失敗したときにミドルウェアの問題だと即断できる。
 */
function createProbeApp() {
  return new Hono<AppEnv>()
    .onError(errorHandler)
    .use('*', authMiddleware)
    .get('/probe', (c) => {
      const viewer = c.get('viewer');
      return c.json({ role: viewer.role, userId: viewer.userId });
    });
}

describe('authMiddleware', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('Cookie が無いリクエストは匿名になる', async () => {
    const res = await createProbeApp().request('/probe', {}, createTestBindings(world));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: ROLE_ANONYMOUS, userId: null });
  });

  it('無効な Cookie のリクエストも匿名になる（例外にしない）', async () => {
    const res = await createProbeApp().request(
      '/probe',
      { headers: { cookie: 'better-auth.session_token=deadbeef' } },
      createTestBindings(world),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: ROLE_ANONYMOUS, userId: null });
  });

  it('user のセッションから UserActor を載せる', async () => {
    const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);

    const res = await createProbeApp().request(
      '/probe',
      { headers: { cookie: alice.cookie } },
      createTestBindings(world),
    );

    expect(await res.json()).toEqual({ role: ROLE_USER, userId: alice.userId });
  });

  it('owner のセッションから OwnerActor を載せる', async () => {
    const bob = await signUpAs(world, 'bob@example.com', ROLE_OWNER);

    const res = await createProbeApp().request(
      '/probe',
      { headers: { cookie: bob.cookie } },
      createTestBindings(world),
    );

    expect(await res.json()).toEqual({ role: ROLE_OWNER, userId: bob.userId });
  });

  it('admin のセッションから AdminActor を載せる', async () => {
    const carol = await signUpAs(world, 'carol@example.com', ROLE_ADMIN);

    const res = await createProbeApp().request(
      '/probe',
      { headers: { cookie: carol.cookie } },
      createTestBindings(world),
    );

    expect(await res.json()).toEqual({ role: ROLE_ADMIN, userId: carol.userId });
  });

  it('profiles が消えたユーザーは匿名扱いになる', async () => {
    const dave = await signUpAs(world, 'dave@example.com', ROLE_USER);
    await runWrite(world, 'DELETE FROM profiles WHERE user_id = ?', dave.userId);

    const res = await createProbeApp().request(
      '/probe',
      { headers: { cookie: dave.cookie } },
      createTestBindings(world),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: ROLE_ANONYMOUS, userId: null });
  });

  it('停止中のユーザーは 403 になる', async () => {
    const eve = await signUpAs(world, 'eve@example.com', ROLE_USER);
    await runWrite(
      world,
      'UPDATE profiles SET status = ? WHERE user_id = ?',
      PROFILE_STATUS_SUSPENDED,
      eve.userId,
    );

    const res = await createProbeApp().request(
      '/probe',
      { headers: { cookie: eve.cookie } },
      createTestBindings(world),
    );

    expect(res.status).toBe(403);
  });

  it('停止中の admin も 403 になる', async () => {
    const frank = await signUpAs(world, 'frank@example.com', ROLE_ADMIN);
    await runWrite(
      world,
      'UPDATE profiles SET status = ? WHERE user_id = ?',
      PROFILE_STATUS_SUSPENDED,
      frank.userId,
    );

    const res = await createProbeApp().request(
      '/probe',
      { headers: { cookie: frank.cookie } },
      createTestBindings(world),
    );

    expect(res.status).toBe(403);
  });

  it('role が壊れているユーザーは 403 になる', async () => {
    const grace = await signUpAs(world, 'grace@example.com', ROLE_USER);
    await corruptProfileRole(world, grace.userId, 'superuser');

    const res = await createProbeApp().request(
      '/probe',
      { headers: { cookie: grace.cookie } },
      createTestBindings(world),
    );

    expect(res.status).toBe(403);
  });

  it('403 の本文にユーザー ID もテーブル名も載らない', async () => {
    const heidi = await signUpAs(world, 'heidi@example.com', ROLE_USER);
    await runWrite(
      world,
      'UPDATE profiles SET status = ? WHERE user_id = ?',
      PROFILE_STATUS_SUSPENDED,
      heidi.userId,
    );

    const res = await createProbeApp().request(
      '/probe',
      { headers: { cookie: heidi.cookie } },
      createTestBindings(world),
    );
    const text = await res.text();

    expect(JSON.parse(text)).toEqual({ error: { status: 403, message: ERROR_MESSAGE_FORBIDDEN } });
    expect(text).not.toContain(heidi.userId);
    expect(text).not.toContain('profiles');
  });

  it('別ユーザーの Cookie でロールが入れ替わらない', async () => {
    const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
    await signUpAs(world, 'carol@example.com', ROLE_ADMIN);

    const res = await createProbeApp().request(
      '/probe',
      { headers: { cookie: alice.cookie } },
      createTestBindings(world),
    );

    expect(await res.json()).toEqual({ role: ROLE_USER, userId: alice.userId });
  });
});
