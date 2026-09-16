import { AUTH_BASE_PATH, createAuth } from '../auth/auth';
import { createDatabase } from '../db/client';
import { PROFILE_STATUS_ACTIVE, ROLE_USER, SHOP_STATUS_PUBLISHED } from '../db/constants';
import type { ProfileStatus, Role, ShopStatus } from '../db/constants';
import { createMigratedD1 } from '../db/testing/local-d1';
import type { AppBindings } from '../lib/app-env';

/** D1 にバインドできる値。boolean も通るが、テストでは 0/1 を明示して曖昧さを消す */
export type SqlParam = string | number | null;

/**
 * テスト 1 件ごとに使い捨てる世界。
 * 中身は Phase 3 の `createMigratedD1()` が返す miniflare（= 本物の workerd SQLite）製の D1。
 * Phase 4 で D1 のフェイクを作らない理由は計画書「テスト環境の選定」を参照。
 */
export type TestWorld = {
  readonly d1: D1Database;
  readonly dispose: () => Promise<void>;
};

/** テストで使うジャンル。shops.genre_id は NOT NULL かつ genres への外部キー */
export const TEST_GENRE_ID = 'gnr_ramen';
/** テストで使うエリア。shops.area_id は NOT NULL かつ areas への外部キー */
export const TEST_AREA_ID = 'are_shibuya';
/** 渋谷駅付近。境界値ではない「普通の」座標を 1 つ決めておく */
export const TEST_LATITUDE = 35.658;
export const TEST_LONGITUDE = 139.7016;
/** 上の座標を precision 7 で符号化した値。ck_shops_geohash_alphabet を満たす */
export const TEST_GEOHASH = 'xn76fgr';

export async function createTestWorld(): Promise<TestWorld> {
  const local = await createMigratedD1();
  return { d1: local.d1, dispose: local.dispose };
}

/**
 * 1 行だけ読む。**リポジトリ層を通さずに DB の実体を見る**ために使う。
 * 「403 は返ったが実は書き込まれていた」を検出できるのは、この経路だけ。
 */
export async function readRow(
  world: TestWorld,
  sql: string,
  ...params: readonly SqlParam[]
): Promise<Record<string, unknown> | null> {
  return await world.d1
    .prepare(sql)
    .bind(...params)
    .first<Record<string, unknown>>();
}

/** `SELECT COUNT(*) AS count ...` の結果を数値で返す */
export async function countRows(
  world: TestWorld,
  sql: string,
  ...params: readonly SqlParam[]
): Promise<number> {
  const row = await world.d1
    .prepare(sql)
    .bind(...params)
    .first<{ count: number }>();
  return row === null ? 0 : row.count;
}

/** INSERT / UPDATE / DELETE を実行し、影響を受けた行数を返す */
export async function runWrite(
  world: TestWorld,
  sql: string,
  ...params: readonly SqlParam[]
): Promise<number> {
  const result = await world.d1
    .prepare(sql)
    .bind(...params)
    .run();
  return result.meta.changes;
}

/**
 * shops の外部キー（genres / areas は ON DELETE restrict）を満たすためのマスタを入れる。
 * これを呼ばずに seedShop すると FOREIGN KEY constraint failed になる。
 */
export async function seedMasters(world: TestWorld): Promise<void> {
  await runWrite(
    world,
    'INSERT INTO genres (id, name, slug, icon_key, sort_order) VALUES (?, ?, ?, ?, ?)',
    TEST_GENRE_ID,
    'ラーメン',
    'ramen',
    null,
    0,
  );
  await runWrite(
    world,
    'INSERT INTO areas (id, name, parent_id, prefecture) VALUES (?, ?, ?, ?)',
    TEST_AREA_ID,
    '渋谷',
    null,
    '東京都',
  );
}

export type SeedUserOptions = {
  readonly userId: string;
  readonly role: Role;
  readonly status?: ProfileStatus;
  readonly displayName?: string;
};

/**
 * Better Auth を通さずに user + profiles を作る。
 * サインアップは scrypt で 100ms 前後かかるため、**セッションが要らないテストでは使わない**。
 * セッション付きのユーザーが要るときは Task 4-5 の `signUpAs` を使う。
 */
export async function seedUser(world: TestWorld, options: SeedUserOptions): Promise<void> {
  const displayName = options.displayName ?? options.userId;
  await runWrite(
    world,
    'INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    options.userId,
    displayName,
    // example.test は RFC 6761 の予約 TLD。実在ドメインに送信事故が起きない
    `${options.userId}@example.test`,
    0,
    0,
    0,
  );
  await runWrite(
    world,
    'INSERT INTO profiles (user_id, role, display_name, avatar_key, bio, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    options.userId,
    options.role,
    displayName,
    null,
    null,
    options.status ?? PROFILE_STATUS_ACTIVE,
    0,
  );
}

export type SeedShopOptions = {
  readonly id: string;
  /** shops.owner_id は NULL 可（オーナー退会で set null されるため） */
  readonly ownerId: string | null;
  readonly name?: string;
  readonly status?: ShopStatus;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly geohash?: string;
  /** ミリ秒。生の SQL で入れるので Date ではなく整数で渡す */
  readonly createdAtMs?: number;
  readonly updatedAtMs?: number;
};

/**
 * 店舗を 1 行作る。既定は published。
 * NOT NULL 制約と CHECK 制約をすべて満たす値を埋めるため、呼び出し側は
 * 検証したい列（owner_id / status / name）だけを指定すればよい。
 */
export async function seedShop(world: TestWorld, options: SeedShopOptions): Promise<void> {
  await runWrite(
    world,
    'INSERT INTO shops (id, owner_id, name, name_kana, genre_id, area_id, description, postal_code, address, lat, lng, geohash, phone, website, budget_lunch_min, budget_lunch_max, budget_dinner_min, budget_dinner_max, status, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    options.id,
    options.ownerId,
    options.name ?? `${options.id} 店`,
    null,
    TEST_GENRE_ID,
    TEST_AREA_ID,
    null,
    null,
    '東京都渋谷区道玄坂 1-1-1',
    options.latitude ?? TEST_LATITUDE,
    options.longitude ?? TEST_LONGITUDE,
    options.geohash ?? TEST_GEOHASH,
    null,
    null,
    null,
    null,
    null,
    null,
    options.status ?? SHOP_STATUS_PUBLISHED,
    options.createdAtMs ?? 0,
    options.updatedAtMs ?? 0,
  );
}

/** Better Auth の baseURL。テストのリクエストもこの origin で投げる */
export const TEST_BASE_URL = 'http://localhost:8787';
/** 本番の鍵は wrangler secret で入れる。テストでは固定値でよい */
export const TEST_BETTER_AUTH_SECRET = 'test-secret-value-at-least-32-characters-long';
/** wrangler.jsonc の vars と同じ「スキーム名だけ」の形。`://` は auth.ts が付ける */
export const TEST_MOBILE_APP_SCHEME = 'meshimap';

/**
 * Phase 4 のテストが実際に読むバインディングだけを持つ型。
 * R2 / KV / Durable Object のダミーを `as` で捏造しないための絞り込み。
 * `app.request(path, init, bindings)` の第 3 引数の型は `AppBindings | {}` なので、
 * 部分的なオブジェクトでもそのまま渡せる。
 * 返り値に型注釈を付けてあるので、キー名を打ち間違えれば AppBindings との照合でコンパイルエラーになる。
 */
export type TestBindings = Pick<
  AppBindings,
  'DB' | 'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL' | 'MOBILE_APP_SCHEME'
>;

export function createTestBindings(world: TestWorld): TestBindings {
  return {
    DB: world.d1,
    BETTER_AUTH_SECRET: TEST_BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: TEST_BASE_URL,
    MOBILE_APP_SCHEME: TEST_MOBILE_APP_SCHEME,
  };
}

export type TestUser = {
  readonly userId: string;
  readonly email: string;
  /** `name=value` の形。リクエストの `cookie` ヘッダにそのまま入れる */
  readonly cookie: string;
};

/**
 * Better Auth で本当にサインアップし、profiles のロールを指定値へ変える。
 *
 * ロールを INSERT ではなく UPDATE するのは、`databaseHooks.user.create.after` が
 * すでに `role = 'user'` の行を作っているため。INSERT すると PRIMARY KEY 衝突で落ちる。
 *
 * 認証経路を本物のまま通すので、Actor は必ず authMiddleware が生成する
 * （fixtures は `toActor` を呼ばない）。
 */
export async function signUpAs(
  world: TestWorld,
  email: string,
  role: Role = ROLE_USER,
): Promise<TestUser> {
  const bindings = createTestBindings(world);
  const auth = createAuth(createDatabase(world.d1), bindings);

  const response = await auth.handler(
    new Request(`${TEST_BASE_URL}${AUTH_BASE_PATH}/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: TEST_BASE_URL },
      body: JSON.stringify({ email, password: 'password1234', name: email }),
    }),
  );
  if (response.status !== 200) {
    throw new Error(`サインアップに失敗した: ${response.status}`);
  }
  const body = await response.json<{ user: { id: string } }>();
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  const changed = await runWrite(
    world,
    'UPDATE profiles SET role = ? WHERE user_id = ?',
    role,
    body.user.id,
  );
  // databaseHooks が profiles を作らなくなったら、ここで気付けるようにする
  if (changed !== 1) {
    throw new Error(`profiles の更新行数が想定外: ${changed}`);
  }

  return { userId: body.user.id, email, cookie };
}

/**
 * profiles.role に CHECK 制約が許さない値を無理やり書き込む。
 *
 * 本番では起き得ないが、**マイグレーション事故や DB 直編集で壊れた値が入ったときに
 * API が通してしまわないこと**を証明するために必要。
 * `PRAGMA ignore_check_constraints` は接続に対する設定なので、必ず OFF に戻してから抜ける。
 * 戻し忘れると、以降の同じ world でのテストが制約なしの緩い世界で回ってしまう。
 */
export async function corruptProfileRole(
  world: TestWorld,
  userId: string,
  role: string,
): Promise<void> {
  await world.d1.prepare('PRAGMA ignore_check_constraints = ON').run();
  try {
    const changed = await runWrite(
      world,
      'UPDATE profiles SET role = ? WHERE user_id = ?',
      role,
      userId,
    );
    if (changed !== 1) {
      throw new Error(`profiles の更新行数が想定外: ${changed}`);
    }
  } finally {
    await world.d1.prepare('PRAGMA ignore_check_constraints = OFF').run();
  }
}
