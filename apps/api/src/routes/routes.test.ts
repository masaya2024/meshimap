import { ROLE_ADMIN, ROLE_OWNER, ROLE_USER } from '@meshimap/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REVIEW_STATUS_HIDDEN, SHOP_STATUS_DRAFT, SHOP_STATUS_PUBLISHED } from '../db/constants';
import { app } from '../index';
import {
  corruptProfileRole,
  createTestBindings,
  createTestWorld,
  readRow,
  seedMasters,
  seedReview,
  seedShop,
  signUpAs,
  TEST_AREA_ID,
  TEST_GENRE_ID,
} from '../test/fixtures';
import type { TestUser, TestWorld } from '../test/fixtures';

const BASE_URL = 'http://localhost:8787';

/**
 * shopCreateSchema を満たす最小のボディ。
 * genreId / areaId は **実在するマスタ**でなければ外部キー違反になる。
 * 架空の 'izakaya' などを書くと 201 のはずが 500 になる（本物の D1 で実測）。
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

function jsonRequest(path: string, method: string, body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie !== undefined) {
    headers['cookie'] = cookie;
  }
  return new Request(`${BASE_URL}${path}`, { method, headers, body: JSON.stringify(body) });
}

describe('routes', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
    // shops.genre_id / area_id は NOT NULL かつ外部キー。どのテストでも要る
    await seedMasters(world);
  });

  afterEach(async () => {
    await world.dispose();
  });

  /** cookie 無しで GET する。未認証（AnonymousActor）の経路 */
  async function getAnonymously(path: string): Promise<Response> {
    return await app.request(path, {}, createTestBindings(world));
  }

  /** cookie 付きで GET する */
  async function getAs(path: string, actor: TestUser): Promise<Response> {
    return await app.request(
      path,
      { headers: { cookie: actor.cookie } },
      createTestBindings(world),
    );
  }

  /** cookie 付きで DELETE する */
  async function deleteAs(path: string, actor: TestUser): Promise<Response> {
    return await app.request(
      path,
      { method: 'DELETE', headers: { cookie: actor.cookie } },
      createTestBindings(world),
    );
  }

  /** ボディ付きのメソッドは Request を組み立てて渡す（第 2 引数は undefined にする） */
  async function sendJson(request: Request): Promise<Response> {
    return await app.request(request, undefined, createTestBindings(world));
  }

  describe('GET /health', () => {
    it('認証なしで 200 と ok を返す', async () => {
      const res = await getAnonymously('/health');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    });
  });

  describe('GET /me', () => {
    it('未認証は 401', async () => {
      const res = await getAnonymously('/me');
      expect(res.status).toBe(401);
    });

    it('認証済みは自分のプロフィールを返す', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);

      const res = await getAs('/me', alice);

      expect(res.status).toBe(200);
      // signUpAs は name にメールアドレスをそのまま渡すため displayName もメールになる
      expect(await res.json()).toEqual({
        profile: { userId: alice.userId, role: ROLE_USER, displayName: 'alice@example.com' },
      });
    });
  });

  describe('GET /shops', () => {
    /** owner_id を持つ店舗を作るには user 行が要る。owner を先に作ってから店舗を撒く */
    async function seedThreeShops(owner: TestUser): Promise<void> {
      await seedShop(world, { id: 'shp_pub', ownerId: null, status: SHOP_STATUS_PUBLISHED });
      await seedShop(world, { id: 'shp_draft', ownerId: null, status: SHOP_STATUS_DRAFT });
      await seedShop(world, {
        id: 'shp_mine_draft',
        ownerId: owner.userId,
        status: SHOP_STATUS_DRAFT,
      });
    }

    async function listedIds(res: Response): Promise<string[]> {
      const body = await res.json<{ shops: { id: string }[] }>();
      return body.shops.map((shop) => shop.id);
    }

    it('未認証には published だけを返す', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      await seedThreeShops(owner);

      const res = await getAnonymously('/shops');

      expect(res.status).toBe(200);
      expect(await listedIds(res)).toEqual(['shp_pub']);
    });

    it('owner には published と「自分の」draft を返す', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      await seedThreeShops(owner);

      const res = await getAs('/shops', owner);

      // created_at は seedShop の既定で全件 0。順序は保証されないのでソートして比べる
      expect((await listedIds(res)).sort()).toEqual(['shp_mine_draft', 'shp_pub']);
    });

    it('admin には status を問わず全件返す', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);
      await seedThreeShops(owner);

      const res = await getAs('/shops', admin);

      expect((await listedIds(res)).sort()).toEqual(['shp_draft', 'shp_mine_draft', 'shp_pub']);
    });
  });

  describe('GET /shops/:shopId', () => {
    it('published は未認証でも 200', async () => {
      await seedShop(world, { id: 'shp_pub', ownerId: null, status: SHOP_STATUS_PUBLISHED });

      const res = await getAnonymously('/shops/shp_pub');

      expect(res.status).toBe(200);
    });

    it('他人の draft は 404', async () => {
      await seedShop(world, { id: 'shp_draft', ownerId: null, status: SHOP_STATUS_DRAFT });

      const res = await getAnonymously('/shops/shp_draft');

      expect(res.status).toBe(404);
    });

    it('存在しない ID と他人の draft で、本文まで完全に一致する', async () => {
      await seedShop(world, { id: 'shp_draft', ownerId: null, status: SHOP_STATUS_DRAFT });

      const hidden = await getAnonymously('/shops/shp_draft');
      const missing = await getAnonymously('/shops/shp_zzz');

      // 状態コードだけ揃えても本文が違えば存在有無が漏れる。本文まで比べる
      expect(hidden.status).toBe(missing.status);
      expect(await hidden.text()).toBe(await missing.text());
    });

    it('ID の形式が不正でも 404（422 にしない）', async () => {
      // %E3%81%82 は「あ」。IDENTIFIER_PATTERN に一致しないので toShopId が RangeError を投げる
      const res = await getAnonymously('/shops/%E3%81%82');

      expect(res.status).toBe(404);
    });

    it('owner は自分の draft を 200 で取得できる', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      await seedShop(world, {
        id: 'shp_mine_draft',
        ownerId: owner.userId,
        status: SHOP_STATUS_DRAFT,
      });

      const res = await getAs('/shops/shp_mine_draft', owner);

      expect(res.status).toBe(200);
    });
  });

  describe('POST /shops', () => {
    it('admin は 201 で作成でき、status は draft から始まる', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);

      const res = await sendJson(
        jsonRequest(`/shops?ownerId=${owner.userId}`, 'POST', NEW_SHOP_BODY, admin.cookie),
      );

      expect(res.status).toBe(201);
      const body = await res.json<{ shop: { id: string; ownerId: string; status: string } }>();
      expect(body.shop.ownerId).toBe(owner.userId);
      expect(body.shop.status).toBe(SHOP_STATUS_DRAFT);
      // 応答だけでなく行が実際に増えたことを DB 側から確認する
      expect(await readRow(world, 'SELECT id FROM shops WHERE id = ?', body.shop.id)).toEqual({
        id: body.shop.id,
      });
    });

    it('ownerId が無いと 422', async () => {
      const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);

      const res = await sendJson(jsonRequest('/shops', 'POST', NEW_SHOP_BODY, admin.cookie));

      expect(res.status).toBe(422);
    });

    it('ボディがスキーマに合わないと 422', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);

      const res = await sendJson(
        jsonRequest(
          `/shops?ownerId=${owner.userId}`,
          'POST',
          { ...NEW_SHOP_BODY, latitude: 999 },
          admin.cookie,
        ),
      );

      expect(res.status).toBe(422);
    });

    it('422 の本文にフィールド名が含まれない', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);

      const res = await sendJson(
        jsonRequest(
          `/shops?ownerId=${owner.userId}`,
          'POST',
          { ...NEW_SHOP_BODY, latitude: 999 },
          admin.cookie,
        ),
      );

      // どの項目が弾かれたかを返すと、スキーマの形が総当たりで復元できてしまう
      expect(await res.text()).not.toMatch(/latitude/);
    });
  });

  describe('PATCH /shops/:shopId', () => {
    it('owner は自分の店舗を更新できる', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      await seedShop(world, { id: 'shp_mine', ownerId: owner.userId });

      const res = await sendJson(
        jsonRequest('/shops/shp_mine', 'PATCH', { name: '改名後' }, owner.cookie),
      );

      expect(res.status).toBe(200);
      const body = await res.json<{ shop: { name: string } }>();
      expect(body.shop.name).toBe('改名後');
    });

    it('owner が他人の店舗を更新しようとすると 404', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      await seedShop(world, { id: 'shp_other', ownerId: null, name: '元の名前' });

      const res = await sendJson(
        jsonRequest('/shops/shp_other', 'PATCH', { name: '乗っ取り' }, owner.cookie),
      );

      // ロールは owner で合っているので 403 にはならない。行が一致しないので 404
      expect(res.status).toBe(404);
      expect(await readRow(world, 'SELECT name FROM shops WHERE id = ?', 'shp_other')).toEqual({
        name: '元の名前',
      });
    });

    it('空のボディは 422（shopUpdateSchema の refine）', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      await seedShop(world, { id: 'shp_mine', ownerId: owner.userId });

      const res = await sendJson(jsonRequest('/shops/shp_mine', 'PATCH', {}, owner.cookie));

      expect(res.status).toBe(422);
    });

    it('緯度だけの指定は 422（geohash が壊れるため受け付けない）', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      await seedShop(world, { id: 'shp_mine', ownerId: owner.userId });

      const res = await sendJson(
        jsonRequest('/shops/shp_mine', 'PATCH', { latitude: 34.7 }, owner.cookie),
      );

      expect(res.status).toBe(422);
    });

    it('緯度と経度を両方指定すれば 200 になり geohash も張り替わる', async () => {
      const owner = await signUpAs(world, 'owner@example.com', ROLE_OWNER);
      await seedShop(world, { id: 'shp_mine', ownerId: owner.userId });

      const res = await sendJson(
        jsonRequest(
          '/shops/shp_mine',
          'PATCH',
          { latitude: 34.702485, longitude: 135.495951 },
          owner.cookie,
        ),
      );

      expect(res.status).toBe(200);
      // 大阪駅。precision 7 で xn0m7m3（本物の D1 で実測した値）
      expect(
        await readRow(world, 'SELECT geohash, lat, lng FROM shops WHERE id = ?', 'shp_mine'),
      ).toEqual({ geohash: 'xn0m7m3', lat: 34.702485, lng: 135.495951 });
    });

    it('admin は他人の店舗を更新できる', async () => {
      const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);
      await seedShop(world, { id: 'shp_other', ownerId: null });

      const res = await sendJson(
        jsonRequest('/shops/shp_other', 'PATCH', { name: '管理者改名' }, admin.cookie),
      );

      expect(res.status).toBe(200);
    });
  });

  describe('DELETE /shops/:shopId', () => {
    it('admin は 204 で削除でき、本文は空', async () => {
      const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);
      await seedShop(world, { id: 'shp_x', ownerId: null });

      const res = await deleteAs('/shops/shp_x', admin);

      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
      expect(await readRow(world, 'SELECT id FROM shops WHERE id = ?', 'shp_x')).toBeNull();
    });

    it('存在しない ID は 404', async () => {
      const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);

      const res = await deleteAs('/shops/shp_zzz', admin);

      expect(res.status).toBe(404);
    });
  });

  describe('GET /shops/:shopId/reviews', () => {
    async function seedTwoReviews(): Promise<void> {
      await seedShop(world, { id: 'shp_pub', ownerId: null });
      // uq_reviews_shop_user があるので、同じ店舗には別々の利用者で入れる
      await signUpAs(world, 'alice@example.com', ROLE_USER);
      const bob = await signUpAs(world, 'bob@example.com', ROLE_USER);
      const carol = await signUpAs(world, 'carol@example.com', ROLE_USER);
      await seedReview(world, { id: 'rev_open', shopId: 'shp_pub', userId: bob.userId });
      await seedReview(world, {
        id: 'rev_hidden',
        shopId: 'shp_pub',
        userId: carol.userId,
        status: REVIEW_STATUS_HIDDEN,
      });
    }

    async function listedReviewIds(res: Response): Promise<string[]> {
      const body = await res.json<{ reviews: { id: string }[] }>();
      return body.reviews.map((review) => review.id);
    }

    it('published なレビューだけを未認証にも返す', async () => {
      await seedTwoReviews();

      const res = await getAnonymously('/shops/shp_pub/reviews');

      expect(res.status).toBe(200);
      expect(await listedReviewIds(res)).toEqual(['rev_open']);
    });

    it('admin には hidden なレビューも返す', async () => {
      await seedTwoReviews();
      const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);

      const res = await getAs('/shops/shp_pub/reviews', admin);

      expect((await listedReviewIds(res)).sort()).toEqual(['rev_hidden', 'rev_open']);
    });
  });

  describe('POST /shops/:shopId/reviews', () => {
    it('user は 201 で投稿でき、userId は自分になる', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      await seedShop(world, { id: 'shp_pub', ownerId: null });

      const res = await sendJson(
        jsonRequest(
          '/shops/shp_pub/reviews',
          'POST',
          {
            shopId: 'shp_pub',
            rating: 5,
            body: 'とても良かった',
            visitedOn: '2026-09-10',
            budgetYen: 3200,
          },
          alice.cookie,
        ),
      );

      expect(res.status).toBe(201);
      const body = await res.json<{ review: { userId: string; shopId: string } }>();
      // ボディに userId を書かせない。書かせると他人になりすませる
      expect(body.review.userId).toBe(alice.userId);
      expect(body.review.shopId).toBe('shp_pub');
    });

    it('URL とボディの shopId が食い違うと 422', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      await seedShop(world, { id: 'shp_pub', ownerId: null });
      await seedShop(world, { id: 'shp_other', ownerId: null });

      const res = await sendJson(
        jsonRequest(
          '/shops/shp_pub/reviews',
          'POST',
          {
            shopId: 'shp_other',
            rating: 5,
            body: 'とても良かった',
            visitedOn: '2026-09-10',
            budgetYen: null,
          },
          alice.cookie,
        ),
      );

      expect(res.status).toBe(422);
    });

    it('見えない店舗へは投稿できない（404）', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      await seedShop(world, { id: 'shp_draft', ownerId: null, status: SHOP_STATUS_DRAFT });

      const res = await sendJson(
        jsonRequest(
          '/shops/shp_draft/reviews',
          'POST',
          {
            shopId: 'shp_draft',
            rating: 5,
            body: 'とても良かった',
            visitedOn: '2026-09-10',
            budgetYen: null,
          },
          alice.cookie,
        ),
      );

      expect(res.status).toBe(404);
      // 404 を返しただけでなく、行が作られていないことを確かめる
      expect(
        await readRow(world, 'SELECT id FROM reviews WHERE shop_id = ?', 'shp_draft'),
      ).toBeNull();
    });

    it('budgetYen を省略しても 201（Zod の default が効く）', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      await seedShop(world, { id: 'shp_pub', ownerId: null });

      const res = await sendJson(
        jsonRequest(
          '/shops/shp_pub/reviews',
          'POST',
          { shopId: 'shp_pub', rating: 4, body: 'ふつう', visitedOn: '2026-09-10' },
          alice.cookie,
        ),
      );

      // RPC の型は budgetYen を必須として要求するが、ランタイムは省略を受け付ける。
      // この差は Hono 4.13.7 の validator の仕様（Task 4-11 の「確定事項 2」）
      expect(res.status).toBe(201);
      const body = await res.json<{ review: { budget: number | null } }>();
      expect(body.review.budget).toBeNull();
    });
  });

  describe('DELETE /reviews/:reviewId', () => {
    it('投稿者本人は 204 で削除できる', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      await seedShop(world, { id: 'shp_pub', ownerId: null });
      await seedReview(world, { id: 'rev_1', shopId: 'shp_pub', userId: alice.userId });

      const res = await deleteAs('/reviews/rev_1', alice);

      expect(res.status).toBe(204);
      expect(await readRow(world, 'SELECT id FROM reviews WHERE id = ?', 'rev_1')).toBeNull();
    });

    it('admin は他人のレビューを 204 で削除できる', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      const admin = await signUpAs(world, 'admin@example.com', ROLE_ADMIN);
      await seedShop(world, { id: 'shp_pub', ownerId: null });
      await seedReview(world, { id: 'rev_1', shopId: 'shp_pub', userId: alice.userId });

      const res = await deleteAs('/reviews/rev_1', admin);

      expect(res.status).toBe(204);
    });

    it('他人のレビューは user には消せず、404 で行も残る', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      const bob = await signUpAs(world, 'bob@example.com', ROLE_USER);
      await seedShop(world, { id: 'shp_pub', ownerId: null });
      await seedReview(world, { id: 'rev_alice', shopId: 'shp_pub', userId: alice.userId });

      const res = await deleteAs('/reviews/rev_alice', bob);

      // 403 にすると「その ID のレビューは存在する」が漏れる。404 に寄せる
      expect(res.status).toBe(404);
      expect(await readRow(world, 'SELECT id FROM reviews WHERE id = ?', 'rev_alice')).toEqual({
        id: 'rev_alice',
      });
    });
  });

  describe('未定義の経路', () => {
    it('未定義のパスは 404 を同じ形の JSON で返す', async () => {
      const res = await getAnonymously('/no-such-path');

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { status: 404, message: '対象が見つかりません' } });
    });

    it('定義済みパスの未定義メソッドも同じ 404 になる', async () => {
      const res = await app.request('/shops/shp_x', { method: 'PUT' }, createTestBindings(world));

      // 405 を返すと「そのパスは存在する」が分かる。404 に寄せる
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { status: 404, message: '対象が見つかりません' } });
    });
  });

  describe('Better Auth のハンドラ', () => {
    it('/api/auth/* が Hono の 404 にも authMiddleware にも飲み込まれない', async () => {
      const res = await sendJson(
        new Request(`${BASE_URL}/api/auth/sign-up/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE_URL },
          body: JSON.stringify({
            email: 'new@example.com',
            password: 'password1234',
            name: 'new',
          }),
        }),
      );

      expect(res.status).toBe(200);
    });

    it('ロールが壊れた利用者でも /api/auth/* に到達できる（サインアウト経路を塞がない）', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      // authMiddleware は invalid-role を 403 にする。Better Auth のハンドラが
      // authMiddleware より **先** に登録されていないと、壊れた利用者は
      // サインアウトすらできず自力で復帰できなくなる
      await corruptProfileRole(world, alice.userId, 'superuser');

      const res = await getAs('/api/auth/get-session', alice);

      expect(res.status).toBe(200);
    });
  });
});
