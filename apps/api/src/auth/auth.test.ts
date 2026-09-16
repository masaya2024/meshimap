import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROFILE_STATUS_ACTIVE, ROLE_USER } from '../db/constants';
import {
  countRows,
  createTestBindings,
  createTestWorld,
  readRow,
  TEST_BASE_URL,
} from '../test/fixtures';
import type { TestWorld } from '../test/fixtures';
import { createDatabase } from '../db/client';
import { PROFILE_DISPLAY_NAME_MAX_LENGTH } from '../lib/constants';
import { AUTH_BASE_PATH, createAuth } from './auth';

/**
 * このテストでは D1 以外のバインディング（R2 / KV / DO）を一切使わない。
 * AppBindings を満たすためだけにダミーを置くと、使っていない依存が増えて壊れやすくなるので、
 * fixtures の createTestBindings が返す「実際に読むキーだけ」のオブジェクトを渡す。
 * 秘密鍵の文字列を 2 箇所に散らすと、片方だけ変えたときに原因を追いにくくなる。
 */
function createTestAuth(world: TestWorld) {
  return createAuth(createDatabase(world.d1), createTestBindings(world));
}

function signUpRequest(body: Record<string, string>): Request {
  return new Request(`${TEST_BASE_URL}${AUTH_BASE_PATH}/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: TEST_BASE_URL },
    body: JSON.stringify(body),
  });
}

function signInRequest(body: Record<string, string>): Request {
  return new Request(`${TEST_BASE_URL}${AUTH_BASE_PATH}/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: TEST_BASE_URL },
    body: JSON.stringify(body),
  });
}

/** `set-cookie` ヘッダから `name=value` の部分だけを取り出す */
function toCookieHeader(response: Response): string {
  const setCookie = response.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0] ?? '';
}

describe('createAuth', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('basePath は /api/auth である', () => {
    expect(AUTH_BASE_PATH).toBe('/api/auth');
  });

  it('メールとパスワードでサインアップできる', async () => {
    const auth = createTestAuth(world);
    const res = await auth.handler(
      signUpRequest({ email: 'alice@example.com', password: 'password1234', name: 'Alice' }),
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ user: { id: string; email: string } }>();
    expect(body.user.email).toBe('alice@example.com');
  });

  it('サインアップで profiles が role=user / status=active で自動作成される', async () => {
    const auth = createTestAuth(world);
    const res = await auth.handler(
      signUpRequest({ email: 'alice@example.com', password: 'password1234', name: 'Alice' }),
    );
    const body = await res.json<{ user: { id: string } }>();

    const profile = await readRow(
      world,
      'SELECT user_id, role, display_name, status FROM profiles WHERE user_id = ?',
      body.user.id,
    );

    expect(profile).toStrictEqual({
      user_id: body.user.id,
      role: ROLE_USER,
      display_name: 'Alice',
      status: PROFILE_STATUS_ACTIVE,
    });
  });

  it('表示名が長すぎてもサインアップが 500 にならず、上限まで切り詰められる', async () => {
    // profiles.display_name には CHECK(length(...) <= 50) が掛かっている。
    // 切り詰めずに INSERT すると databaseHooks の中で例外が出てサインアップ全体が落ちる。
    const auth = createTestAuth(world);
    const longName = 'あ'.repeat(PROFILE_DISPLAY_NAME_MAX_LENGTH + 30);

    const res = await auth.handler(
      signUpRequest({ email: 'long@example.com', password: 'password1234', name: longName }),
    );

    expect(res.status).toBe(200);
    const profile = await readRow(
      world,
      'SELECT length(display_name) AS length FROM profiles WHERE display_name IS NOT NULL',
    );
    expect(profile).toStrictEqual({ length: PROFILE_DISPLAY_NAME_MAX_LENGTH });
  });

  it('サインインでセッション Cookie が発行される', async () => {
    const auth = createTestAuth(world);
    await auth.handler(
      signUpRequest({ email: 'alice@example.com', password: 'password1234', name: 'Alice' }),
    );

    const res = await auth.handler(
      signInRequest({ email: 'alice@example.com', password: 'password1234' }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('session_token');
  });

  it('Cookie 付きで getSession を呼ぶとユーザーが取れる', async () => {
    const auth = createTestAuth(world);
    const signUpRes = await auth.handler(
      signUpRequest({ email: 'alice@example.com', password: 'password1234', name: 'Alice' }),
    );

    const session = await auth.api.getSession({
      headers: new Headers({ cookie: toCookieHeader(signUpRes) }),
    });

    expect(session).not.toBeNull();
    expect(session?.user.email).toBe('alice@example.com');
  });

  it('Cookie なしで getSession を呼ぶと null になる', async () => {
    const auth = createTestAuth(world);
    const session = await auth.api.getSession({ headers: new Headers() });
    expect(session).toBeNull();
  });

  it('壊れた Cookie では null になる（例外にならない）', async () => {
    const auth = createTestAuth(world);
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: 'better-auth.session_token=deadbeef' }),
    });
    expect(session).toBeNull();
  });

  it('別の秘密鍵で作ったインスタンスでは同じ Cookie が通らない', async () => {
    // セッション Cookie は secret で署名されている。
    // 署名検証を外すと「他人が組み立てた Cookie」で入れてしまう。
    const auth = createTestAuth(world);
    const signUpRes = await auth.handler(
      signUpRequest({ email: 'alice@example.com', password: 'password1234', name: 'Alice' }),
    );
    const cookie = toCookieHeader(signUpRes);

    const otherAuth = createAuth(createDatabase(world.d1), {
      ...createTestBindings(world),
      BETTER_AUTH_SECRET: 'a-completely-different-secret-value-32ch',
    });

    expect(await otherAuth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
  });

  it('間違ったパスワードではサインインできない', async () => {
    const auth = createTestAuth(world);
    await auth.handler(
      signUpRequest({ email: 'alice@example.com', password: 'password1234', name: 'Alice' }),
    );

    const res = await auth.handler(
      signInRequest({ email: 'alice@example.com', password: 'wrong-password' }),
    );

    // 実測値は 401。将来 429 などに変わっても「通らない」ことが本質なので不等号で見る
    expect(res.status).not.toBe(200);
  });

  it('サインアップに失敗したときは user も profiles も残らない', async () => {
    const auth = createTestAuth(world);
    await auth.handler(
      signUpRequest({ email: 'alice@example.com', password: 'password1234', name: 'Alice' }),
    );
    // 同じメールアドレスは user.email の UNIQUE 制約で弾かれる
    const res = await auth.handler(
      signUpRequest({ email: 'alice@example.com', password: 'password1234', name: 'Alice2' }),
    );

    expect(res.status).not.toBe(200);
    expect(await countRows(world, 'SELECT COUNT(*) AS count FROM user')).toBe(1);
    expect(await countRows(world, 'SELECT COUNT(*) AS count FROM profiles')).toBe(1);
  });
});
