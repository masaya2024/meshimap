import { ROLE_ADMIN, ROLE_OWNER, ROLE_USER } from '@meshimap/core';
import { hc } from 'hono/client';
import { testClient } from 'hono/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHOP_STATUS_DRAFT } from '../db/constants';
import { app } from '../index';
import type { AppType } from '../index';
import type { TestWorld } from '../test/fixtures';
import {
  createTestBindings,
  createTestWorld,
  seedMasters,
  seedShop,
  seedUser,
  signUpAs,
  TEST_AREA_ID,
  TEST_BASE_URL,
  TEST_GENRE_ID,
} from '../test/fixtures';

const SHOP_OWNER_ID = 'usr_shop_owner';
const PUBLISHED_SHOP_ID = 'shp_published';
const DRAFT_SHOP_ID = 'shp_draft';

/**
 * `hc<AppType>` が要求するボディ。`.default()` を持つ列（nameKana / description / phone /
 * website / budget*Yen）も**必ず書く**。省くと tsc が TS2741 を出す。
 * 理由は Task 4-11 の「確定事項 2」。
 */
const NEW_SHOP_BODY = {
  name: '新規店',
  nameKana: 'シンキテン',
  genreId: TEST_GENRE_ID,
  areaId: TEST_AREA_ID,
  description: '',
  postalCode: '104-0061',
  address: '東京都中央区銀座1-1-1',
  latitude: 35.6717,
  longitude: 139.765,
  phone: null,
  website: null,
  budgetLunchMinYen: null,
  budgetLunchMaxYen: null,
  budgetDinnerMinYen: null,
  budgetDinnerMaxYen: null,
};

/** マスタ + オーナー + 公開店舗 1 件 + 他人の下書き 1 件。全テスト共通の下ごしらえ */
async function seedBaseWorld(world: TestWorld): Promise<void> {
  await seedMasters(world);
  await seedUser(world, { userId: SHOP_OWNER_ID, role: ROLE_OWNER });
  await seedShop(world, { id: PUBLISHED_SHOP_ID, ownerId: SHOP_OWNER_ID, name: '公開店' });
  await seedShop(world, { id: DRAFT_SHOP_ID, ownerId: SHOP_OWNER_ID, status: SHOP_STATUS_DRAFT });
}

describe('RPC 契約（匿名クライアント）', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
    await seedBaseWorld(world);
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('GET /health は status: ok を返し、型も "ok" リテラルに絞られる', async () => {
    const client = testClient(app, createTestBindings(world));
    const res = await client.health.$get();
    const body = await res.json();
    // 代入先に 'ok' リテラル型を書いているので、レスポンス型が広がれば tsc が落ちる
    const status: 'ok' = body.status;
    expect(status).toBe('ok');
  });

  it('GET /shops は published の店舗だけを返す', async () => {
    const client = testClient(app, createTestBindings(world));
    const res = await client.shops.$get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shops.map((shop) => shop.id)).toEqual([PUBLISHED_SHOP_ID]);
  });

  it('GET /shops/:shopId は param 経由で公開店舗を取得できる', async () => {
    const client = testClient(app, createTestBindings(world));
    const res = await client.shops[':shopId'].$get({ param: { shopId: PUBLISHED_SHOP_ID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shop.name).toBe('公開店');
  });

  it('GET /shops/:shopId は他人の下書きに 404 を返す', async () => {
    const client = testClient(app, createTestBindings(world));
    const res = await client.shops[':shopId'].$get({ param: { shopId: DRAFT_SHOP_ID } });
    expect(res.status).toBe(404);
  });

  it('GET /shops/:shopId/reviews はレビューが無ければ空配列を返す', async () => {
    const client = testClient(app, createTestBindings(world));
    const res = await client.shops[':shopId'].reviews.$get({
      param: { shopId: PUBLISHED_SHOP_ID },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reviews).toEqual([]);
  });

  it('GET /me は Cookie が無ければ 401 を返す', async () => {
    const client = testClient(app, createTestBindings(world));
    const res = await client.me.$get();
    expect(res.status).toBe(401);
  });
});

describe('RPC 契約（Cookie 付きクライアント）', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
    await seedBaseWorld(world);
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('admin の Cookie を載せると GET /me が自分のロールを返す', async () => {
    const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);
    const client = testClient(app, createTestBindings(world), undefined, {
      headers: { cookie: admin.cookie },
    });
    const res = await client.me.$get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.role).toBe(ROLE_ADMIN);
    expect(body.profile.userId).toBe(admin.userId);
  });

  it('POST /shops は query と json を両方型付きで送れる', async () => {
    const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);
    const client = testClient(app, createTestBindings(world), undefined, {
      headers: { cookie: admin.cookie },
    });
    const res = await client.shops.$post({
      query: { ownerId: SHOP_OWNER_ID },
      json: NEW_SHOP_BODY,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.shop.ownerId).toBe(SHOP_OWNER_ID);
    // 作成直後は必ず下書き。公開は別途 PATCH する運用（Task 4-8 で確認済み）
    expect(body.shop.status).toBe(SHOP_STATUS_DRAFT);
  });

  it('PATCH /shops/:shopId は param と json を組み合わせて更新できる', async () => {
    const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);
    const client = testClient(app, createTestBindings(world), undefined, {
      headers: { cookie: admin.cookie },
    });
    const res = await client.shops[':shopId'].$patch({
      param: { shopId: PUBLISHED_SHOP_ID },
      json: { name: '改名後' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shop.name).toBe('改名後');
  });

  it('DELETE /shops/:shopId は 204 を返し、本文を持たない', async () => {
    const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);
    const client = testClient(app, createTestBindings(world), undefined, {
      headers: { cookie: admin.cookie },
    });
    const res = await client.shops[':shopId'].$delete({ param: { shopId: PUBLISHED_SHOP_ID } });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('user は POST /shops/:shopId/reviews で投稿し、DELETE /reviews/:reviewId で消せる', async () => {
    const author = await signUpAs(world, 'user@example.com', ROLE_USER);
    const client = testClient(app, createTestBindings(world), undefined, {
      headers: { cookie: author.cookie },
    });
    const posted = await client.shops[':shopId'].reviews.$post({
      param: { shopId: PUBLISHED_SHOP_ID },
      json: {
        shopId: PUBLISHED_SHOP_ID,
        rating: 5,
        body: 'とても良かった',
        visitedOn: '2026-09-10',
        budgetYen: 3200,
      },
    });
    expect(posted.status).toBe(201);
    const postedBody = await posted.json();
    expect(postedBody.review.rating).toBe(5);

    const removed = await client.reviews[':reviewId'].$delete({
      param: { reviewId: postedBody.review.id },
    });
    expect(removed.status).toBe(204);
  });
});

describe('型が要求するものとサーバが受け取るもののズレ', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
    await seedBaseWorld(world);
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('hc の型は必須でも、default を持つ列を省いたボディをサーバは 201 で受け取る', async () => {
    const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);
    // hc<AppType> では書けないボディ。ズレの向きを固定するため生のリクエストで投げる
    const res = await app.request(
      new Request(`${TEST_BASE_URL}/shops?ownerId=${SHOP_OWNER_ID}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: admin.cookie },
        body: JSON.stringify({
          name: '最小店',
          genreId: TEST_GENRE_ID,
          areaId: TEST_AREA_ID,
          postalCode: '104-0061',
          address: '東京都中央区銀座1-1-1',
          latitude: 35.6717,
          longitude: 139.765,
        }),
      }),
      undefined,
      createTestBindings(world),
    );
    expect(res.status).toBe(201);
    const body = await res.json<{ shop: { nameKana: string; description: string; phone: null } }>();
    // Zod の .default() が埋めた値がそのまま列に入る
    expect(body.shop.nameKana).toBe('');
    expect(body.shop.description).toBe('');
    expect(body.shop.phone).toBeNull();
  });

  it('budgetYen を省いたレビューも 201 になり budget は null で入る', async () => {
    const author = await signUpAs(world, 'user@example.com', ROLE_USER);
    const res = await app.request(
      new Request(`${TEST_BASE_URL}/shops/${PUBLISHED_SHOP_ID}/reviews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: author.cookie },
        body: JSON.stringify({
          shopId: PUBLISHED_SHOP_ID,
          rating: 5,
          body: 'よかった',
          visitedOn: '2026-09-10',
        }),
      }),
      undefined,
      createTestBindings(world),
    );
    expect(res.status).toBe(201);
    const body = await res.json<{ review: { budget: number | null } }>();
    expect(body.review.budget).toBeNull();
  });
});

/**
 * Phase 5 のモバイルが書くのと同じ形。ここでは**型が付くかどうかだけ**を見る。
 * 実リクエストは上の testClient 側で済ませてある。
 */
const rpcClient = hc<AppType>(TEST_BASE_URL);

/** 正しい呼び出しが型エラーにならないことの確認。実行しない */
async function typeOnlyValidCalls(): Promise<void> {
  const list = await rpcClient.shops.$get();
  const listBody = await list.json();
  const ids: string[] = listBody.shops.map((shop) => shop.id);
  void ids;

  const detail = await rpcClient.shops[':shopId'].$get({ param: { shopId: 'shp_1' } });
  if (detail.status === 200) {
    const detailBody = await detail.json();
    const name: string = detailBody.shop.name;
    void name;
  }

  const created = await rpcClient.shops.$post({
    query: { ownerId: SHOP_OWNER_ID },
    json: NEW_SHOP_BODY,
  });
  const createdBody = await created.json();
  const newShopId: string = createdBody.shop.id;

  const patched = await rpcClient.shops[':shopId'].$patch({
    param: { shopId: newShopId },
    json: { name: '改名後' },
  });
  void patched;

  const removed = await rpcClient.shops[':shopId'].$delete({ param: { shopId: newShopId } });
  void removed;

  const reviewRemoved = await rpcClient.reviews[':reviewId'].$delete({
    param: { reviewId: 'rev_1' },
  });
  void reviewRemoved;
}

/**
 * 間違った呼び出しが**必ず型エラーになる**ことの確認。実行しない。
 * 下のディレクティブは「次の行がエラーであること」を要求するので、
 * ここが素通りするようになったら tsc が TS2578（未使用のディレクティブ）で落ちる。
 * つまりこの関数は「型が緩くなったら気付ける」仕掛けそのもの。
 */
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access --
   `@ts-expect-error` で握り潰した式は型が解決できないまま残るので、型認識 ESLint ルールが
   「安全でない呼び出し」として誤検知する。ここは tsc がエラーを出すこと自体が目的の
   実行されないブロックなので、実行時の安全性とは無関係 */
async function typeOnlyInvalidCalls(): Promise<void> {
  // @ts-expect-error param が必須なのに渡していない
  await rpcClient.shops[':shopId'].$get();

  await rpcClient.shops[':shopId'].reviews.$post({
    param: { shopId: 'shp_1' },
    json: {
      shopId: 'shp_1',
      // @ts-expect-error rating は number なのに string を渡している
      rating: '5',
      body: 'よかった',
      visitedOn: '2026-09-10',
      budgetYen: null,
    },
  });

  // @ts-expect-error 定義していないパス
  await rpcClient.unknownPath.$get();

  // @ts-expect-error DELETE は /shops/:shopId にしか無い。/shops 直下には無い
  await rpcClient.shops.$delete();
}
/* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

describe('型検査専用ブロック', () => {
  it('型検査専用の関数は定義されているが、テストからは呼ばれない', () => {
    // noUnusedLocals に引っかからないための参照も兼ねる。
    // 中身を検証するのは vitest ではなく `npm run typecheck -w @meshimap/api`
    expect(typeof typeOnlyValidCalls).toBe('function');
    expect(typeof typeOnlyInvalidCalls).toBe('function');
  });
});
