import { ROLE_OWNER, ROLE_USER } from '@meshimap/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROFILE_STATUS_SUSPENDED,
  REVIEW_STATUS_PUBLISHED,
  SHOP_STATUS_DRAFT,
  SHOP_STATUS_PUBLISHED,
} from '../db/constants';
import { app } from '../index';
import type { TestWorld } from '../test/fixtures';
import {
  countRows,
  createTestBindings,
  createTestWorld,
  readRow,
  runWrite,
  seedMasters,
  seedReview,
  seedShop,
  seedUser,
  signUpAs,
} from '../test/fixtures';

const BASE_URL = 'http://localhost:8787';

/** レビューを載せる店舗の所有者。shops.owner_id は user.id への外部キーなので実在させる */
const SHOP_OWNER_ID = 'usr_shop_owner';

/**
 * 権限侵害の前後で比較するためのスナップショット。1 列でも変わったら toEqual で検出できる。
 * **リポジトリ層を通さない**のが肝心で、リポジトリが壊れたら検証も一緒に壊れる経路では
 * 「触れていないこと」を証明したことにならない。
 */
async function snapshotShop(
  world: TestWorld,
  shopId: string,
): Promise<Record<string, unknown> | null> {
  return await readRow(
    world,
    'SELECT name, owner_id, status, lat, lng, geohash, updated_at FROM shops WHERE id = ?',
    shopId,
  );
}

/** 行が残っているかだけを見る */
async function countReviews(world: TestWorld, reviewId: string): Promise<number> {
  return await countRows(world, 'SELECT COUNT(*) AS count FROM reviews WHERE id = ?', reviewId);
}

function jsonRequest(path: string, method: string, body: unknown, cookie: string): Request {
  return new Request(`${BASE_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

describe('他人のデータへの到達不能性', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
    // shops.genre_id / area_id は NOT NULL かつ外部キー。全テストで必要になる
    await seedMasters(world);
  });

  afterEach(async () => {
    await world.dispose();
  });

  describe('owner A は owner B の店舗に触れない', () => {
    it('PATCH は 404 を返し、B の店舗の全列が変わらない', async () => {
      const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
      const ownerB = await signUpAs(world, 'owner-b@example.com', ROLE_OWNER);
      await seedShop(world, {
        id: 'shp_b',
        ownerId: ownerB.userId,
        status: SHOP_STATUS_PUBLISHED,
        name: 'B の店',
        createdAtMs: 100,
        updatedAtMs: 100,
      });
      const before = await snapshotShop(world, 'shp_b');

      const res = await app.request(
        jsonRequest('/shops/shp_b', 'PATCH', { name: '乗っ取り' }, ownerA.cookie),
        undefined,
        createTestBindings(world),
      );

      expect(res.status).toBe(404);
      // updated_at まで含めて比較する。「更新は失敗したが updatedAt だけ進む」も検出したい
      expect(await snapshotShop(world, 'shp_b')).toEqual(before);
    });

    it('緯度経度の更新でも B の座標と geohash が変わらない', async () => {
      const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
      const ownerB = await signUpAs(world, 'owner-b@example.com', ROLE_OWNER);
      await seedShop(world, { id: 'shp_b', ownerId: ownerB.userId, status: SHOP_STATUS_PUBLISHED });
      const before = await snapshotShop(world, 'shp_b');

      const res = await app.request(
        jsonRequest(
          '/shops/shp_b',
          'PATCH',
          { latitude: 34.702485, longitude: 135.495951 },
          ownerA.cookie,
        ),
        undefined,
        createTestBindings(world),
      );

      expect(res.status).toBe(404);
      expect(await snapshotShop(world, 'shp_b')).toEqual(before);
    });

    it('B の draft 店舗は一覧に出てこない', async () => {
      const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
      const ownerB = await signUpAs(world, 'owner-b@example.com', ROLE_OWNER);
      await seedShop(world, {
        id: 'shp_b_draft',
        ownerId: ownerB.userId,
        status: SHOP_STATUS_DRAFT,
      });
      await seedShop(world, {
        id: 'shp_a_draft',
        ownerId: ownerA.userId,
        status: SHOP_STATUS_DRAFT,
      });

      const res = await app.request(
        '/shops',
        { headers: { cookie: ownerA.cookie } },
        createTestBindings(world),
      );

      const body = await res.json<{ shops: { id: string }[] }>();
      const ids = body.shops.map((shop) => shop.id);
      // 「自分のは見える」まで確認しないと、可視条件が全部落ちていても通ってしまう
      expect(ids).toContain('shp_a_draft');
      expect(ids).not.toContain('shp_b_draft');
    });

    it('B の draft 店舗の名前が応答本文のどこにも現れない', async () => {
      const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
      const ownerB = await signUpAs(world, 'owner-b@example.com', ROLE_OWNER);
      await seedShop(world, {
        id: 'shp_b_draft',
        ownerId: ownerB.userId,
        status: SHOP_STATUS_DRAFT,
        name: '秘密の新店',
      });

      const listRes = await app.request(
        '/shops',
        { headers: { cookie: ownerA.cookie } },
        createTestBindings(world),
      );
      const detailRes = await app.request(
        '/shops/shp_b_draft',
        { headers: { cookie: ownerA.cookie } },
        createTestBindings(world),
      );

      expect(detailRes.status).toBe(404);
      // 構造ではなく生文字列で見る。エラーメッセージや将来の追加フィールドに混ざっても捕まえたい
      expect(await listRes.text()).not.toContain('秘密の新店');
      expect(await detailRes.text()).not.toContain('秘密の新店');
    });
  });

  describe('owner は自分の店舗でも変えてはいけない列がある', () => {
    it('ボディに ownerId を混ぜても所有者は移らない', async () => {
      const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
      const ownerB = await signUpAs(world, 'owner-b@example.com', ROLE_OWNER);
      await seedShop(world, { id: 'shp_a', ownerId: ownerA.userId, status: SHOP_STATUS_PUBLISHED });

      const res = await app.request(
        jsonRequest(
          '/shops/shp_a',
          'PATCH',
          { name: '改名後', ownerId: ownerB.userId },
          ownerA.cookie,
        ),
        undefined,
        createTestBindings(world),
      );

      expect(res.status).toBe(200);
      const row = await snapshotShop(world, 'shp_a');
      // shopUpdateSchema に ownerId が無く Zod の既定が strip、かつ toShopUpdateValues が
      // 列を 1 つずつ写す。この 2 枚のどちらかが残っていれば所有者は移らない
      expect(row?.['owner_id']).toBe(ownerA.userId);
      // 同じリクエストで name は本当に通っている（strip が全部を捨てているのではない）
      expect(row?.['name']).toBe('改名後');
    });

    it('ボディに status を混ぜても勝手に公開されない', async () => {
      const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
      await seedShop(world, { id: 'shp_a', ownerId: ownerA.userId, status: SHOP_STATUS_DRAFT });

      const res = await app.request(
        jsonRequest(
          '/shops/shp_a',
          'PATCH',
          { name: '改名後', status: SHOP_STATUS_PUBLISHED },
          ownerA.cookie,
        ),
        undefined,
        createTestBindings(world),
      );

      expect(res.status).toBe(200);
      // 公開は admin の審査を通す（設計書 4 章）。owner が自力で published にできてはいけない
      expect((await snapshotShop(world, 'shp_a'))?.['status']).toBe(SHOP_STATUS_DRAFT);
    });

    it('ボディに geohash を混ぜても座標と矛盾する値は入らない', async () => {
      const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
      await seedShop(world, { id: 'shp_a', ownerId: ownerA.userId, status: SHOP_STATUS_PUBLISHED });
      const before = await snapshotShop(world, 'shp_a');

      const res = await app.request(
        jsonRequest('/shops/shp_a', 'PATCH', { name: '改名後', geohash: 'zzzzzzz' }, ownerA.cookie),
        undefined,
        createTestBindings(world),
      );

      expect(res.status).toBe(200);
      // 'zzzzzzz' は ck_shops_geohash_alphabet を満たしてしまう（z は base32 に含まれる）。
      // つまり DB の CHECK では止まらず、止めているのはアプリ側の列マッピングだけ
      expect((await snapshotShop(world, 'shp_a'))?.['geohash']).toBe(before?.['geohash']);
    });
  });

  describe('user A は user B のレビューに触れない', () => {
    it('DELETE は 404 を返し、B のレビューが残る', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      const bob = await signUpAs(world, 'bob@example.com', ROLE_USER);
      await seedUser(world, { userId: SHOP_OWNER_ID, role: ROLE_OWNER });
      await seedShop(world, { id: 'shp_1', ownerId: SHOP_OWNER_ID, status: SHOP_STATUS_PUBLISHED });
      await seedReview(world, { id: 'rev_bob', shopId: 'shp_1', userId: bob.userId });

      const res = await app.request(
        '/reviews/rev_bob',
        { method: 'DELETE', headers: { cookie: alice.cookie } },
        createTestBindings(world),
      );

      expect(res.status).toBe(404);
      expect(await countReviews(world, 'rev_bob')).toBe(1);
    });

    it('自分のレビューは消えるが、他人のレビューは巻き添えにならない', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      const bob = await signUpAs(world, 'bob@example.com', ROLE_USER);
      await seedUser(world, { userId: SHOP_OWNER_ID, role: ROLE_OWNER });
      await seedShop(world, { id: 'shp_1', ownerId: SHOP_OWNER_ID, status: SHOP_STATUS_PUBLISHED });
      // uq_reviews_shop_user があるので、同じ店舗には別々の利用者で入れる
      await seedReview(world, { id: 'rev_alice', shopId: 'shp_1', userId: alice.userId });
      await seedReview(world, { id: 'rev_bob', shopId: 'shp_1', userId: bob.userId });

      const res = await app.request(
        '/reviews/rev_alice',
        { method: 'DELETE', headers: { cookie: alice.cookie } },
        createTestBindings(world),
      );

      expect(res.status).toBe(204);
      expect(await countReviews(world, 'rev_alice')).toBe(0);
      expect(await countReviews(world, 'rev_bob')).toBe(1);
    });

    it('ボディに userId を混ぜても投稿者は自分のままになる', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      const bob = await signUpAs(world, 'bob@example.com', ROLE_USER);
      await seedUser(world, { userId: SHOP_OWNER_ID, role: ROLE_OWNER });
      await seedShop(world, { id: 'shp_1', ownerId: SHOP_OWNER_ID, status: SHOP_STATUS_PUBLISHED });

      const res = await app.request(
        jsonRequest(
          '/shops/shp_1/reviews',
          'POST',
          {
            shopId: 'shp_1',
            rating: 5,
            body: 'なりすまし',
            visitedOn: '2026-09-10',
            budgetYen: null,
            userId: bob.userId,
          },
          alice.cookie,
        ),
        undefined,
        createTestBindings(world),
      );

      expect(res.status).toBe(201);
      const created = await res.json<{ review: { userId: string } }>();
      // createReviewAsUser は userId を引数に取らず actor.userId を使う。型として渡す経路が無い
      expect(created.review.userId).toBe(alice.userId);
      expect(created.review.userId).not.toBe(bob.userId);
    });

    it('ボディに status を混ぜても hidden なレビューを作れない', async () => {
      const alice = await signUpAs(world, 'alice@example.com', ROLE_USER);
      await seedUser(world, { userId: SHOP_OWNER_ID, role: ROLE_OWNER });
      await seedShop(world, { id: 'shp_1', ownerId: SHOP_OWNER_ID, status: SHOP_STATUS_PUBLISHED });

      const res = await app.request(
        jsonRequest(
          '/shops/shp_1/reviews',
          'POST',
          {
            shopId: 'shp_1',
            rating: 5,
            body: 'ふつう',
            visitedOn: '2026-09-10',
            budgetYen: null,
            status: 'hidden',
          },
          alice.cookie,
        ),
        undefined,
        createTestBindings(world),
      );

      expect(res.status).toBe(201);
      const created = await res.json<{ review: { status: string } }>();
      expect(created.review.status).toBe(REVIEW_STATUS_PUBLISHED);
    });
  });

  describe('停止されたアカウント', () => {
    it('profiles.status が suspended なら 403 になり、書き込みも起きない', async () => {
      const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
      await seedShop(world, { id: 'shp_a', ownerId: ownerA.userId, status: SHOP_STATUS_PUBLISHED });
      await runWrite(
        world,
        'UPDATE profiles SET status = ? WHERE user_id = ?',
        PROFILE_STATUS_SUSPENDED,
        ownerA.userId,
      );
      const before = await snapshotShop(world, 'shp_a');

      const res = await app.request(
        jsonRequest('/shops/shp_a', 'PATCH', { name: '停止中の更新' }, ownerA.cookie),
        undefined,
        createTestBindings(world),
      );

      expect(res.status).toBe(403);
      expect(await snapshotShop(world, 'shp_a')).toEqual(before);
    });

    it('停止されたアカウントは公開一覧も読めないが、Cookie を捨てれば匿名として読める', async () => {
      const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
      await runWrite(
        world,
        'UPDATE profiles SET status = ? WHERE user_id = ?',
        PROFILE_STATUS_SUSPENDED,
        ownerA.userId,
      );

      const signedInRes = await app.request(
        '/shops',
        { headers: { cookie: ownerA.cookie } },
        createTestBindings(world),
      );
      const anonymousRes = await app.request('/shops', {}, createTestBindings(world));

      // authMiddleware が 403 を投げるので、公開エンドポイントでも止まる
      expect(signedInRes.status).toBe(403);
      // Cookie を捨てれば匿名として読める。公開情報の可用性は損なわれない
      expect(anonymousRes.status).toBe(200);
    });
  });

  describe('セッションの取り違え', () => {
    it('owner A の Cookie で owner B になりすませない', async () => {
      const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
      const ownerB = await signUpAs(world, 'owner-b@example.com', ROLE_OWNER);

      const res = await app.request(
        '/me',
        { headers: { cookie: ownerA.cookie } },
        createTestBindings(world),
      );

      const body = await res.json<{ profile: { userId: string } }>();
      expect(body.profile.userId).toBe(ownerA.userId);
      expect(body.profile.userId).not.toBe(ownerB.userId);
    });

    it('Cookie の値を 1 文字書き換えると匿名に落ちる', async () => {
      const ownerA = await signUpAs(world, 'owner-a@example.com', ROLE_OWNER);
      await seedShop(world, { id: 'shp_a', ownerId: ownerA.userId, status: SHOP_STATUS_PUBLISHED });
      const tampered = `${ownerA.cookie.slice(0, -1)}${ownerA.cookie.endsWith('a') ? 'b' : 'a'}`;
      const before = await snapshotShop(world, 'shp_a');

      const res = await app.request(
        jsonRequest('/shops/shp_a', 'PATCH', { name: '改ざん' }, tampered),
        undefined,
        createTestBindings(world),
      );

      // Better Auth の署名検証に落ちてセッションが取れず、匿名扱いになるので roleGuard が 401 を返す
      expect(res.status).toBe(401);
      expect(await snapshotShop(world, 'shp_a')).toEqual(before);
    });
  });
});
