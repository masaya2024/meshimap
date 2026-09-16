import { toReviewId, toShopId } from '@meshimap/core';
import type { ReviewCreateInput } from '@meshimap/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/client';
import type { Database } from '../db/client';
import {
  REVIEW_STATUS_DELETED,
  REVIEW_STATUS_HIDDEN,
  REVIEW_STATUS_PUBLISHED,
  ROLE_ADMIN,
  ROLE_USER,
} from '../db/constants';
import {
  adminActorOrThrow,
  buildActorForTest,
  countRows,
  createTestWorld,
  readRow,
  rejectionMessageOf,
  seedMasters,
  seedReview,
  seedShop,
  seedUser,
  userActorOrThrow,
} from '../test/fixtures';
import type { TestWorld } from '../test/fixtures';
import {
  createReviewAsUser,
  deleteReviewAsAdmin,
  deleteReviewAsAuthor,
  listVisibleReviews,
} from './review-repository';

const ALICE_ID = 'usr_alice';
const BOB_ID = 'usr_bob';
const CAROL_ID = 'usr_carol';
const ADMIN_ID = 'usr_admin';

const SHOP_ID = 'shp_a';
const OTHER_SHOP_ID = 'shp_b';
/** レビューが 1 件も無い店舗。uq_reviews_shop_user を避けて新規投稿を試す場所 */
const EMPTY_SHOP_ID = 'shp_c';

/** reviewCreateSchema.parse を通した後の形。budgetYen は default(null) で必ず存在する */
const NEW_REVIEW_INPUT: ReviewCreateInput = {
  // identifierSchema 由来なので素の string。ブランド型ではない
  shopId: SHOP_ID,
  rating: 5,
  body: 'とても良かった',
  visitedOn: '2026-09-10',
  budgetYen: 3200,
};

describe('review-repository', () => {
  let world: TestWorld;
  let db: Database;

  const alice = userActorOrThrow(buildActorForTest(ALICE_ID, ROLE_USER));
  const bob = userActorOrThrow(buildActorForTest(BOB_ID, ROLE_USER));
  const carol = userActorOrThrow(buildActorForTest(CAROL_ID, ROLE_USER));
  const admin = adminActorOrThrow(buildActorForTest(ADMIN_ID, ROLE_ADMIN));

  beforeEach(async () => {
    world = await createTestWorld();
    await seedMasters(world);
    await seedUser(world, { userId: ALICE_ID, role: ROLE_USER });
    await seedUser(world, { userId: BOB_ID, role: ROLE_USER });
    await seedUser(world, { userId: CAROL_ID, role: ROLE_USER });
    await seedUser(world, { userId: ADMIN_ID, role: ROLE_ADMIN });
    // owner_id は NULL 可。ここではオーナーを問わないので null にして依存を減らす
    await seedShop(world, { id: SHOP_ID, ownerId: null });
    await seedShop(world, { id: OTHER_SHOP_ID, ownerId: null });
    await seedShop(world, { id: EMPTY_SHOP_ID, ownerId: null });
    // uq_reviews_shop_user があるので (店舗, 利用者) の組は全部ばらばらにする
    await seedReview(world, {
      id: 'rev_alice',
      shopId: SHOP_ID,
      userId: ALICE_ID,
      status: REVIEW_STATUS_PUBLISHED,
      createdAtMs: 10,
    });
    await seedReview(world, {
      id: 'rev_bob',
      shopId: SHOP_ID,
      userId: BOB_ID,
      status: REVIEW_STATUS_PUBLISHED,
      createdAtMs: 20,
    });
    await seedReview(world, {
      id: 'rev_hidden',
      shopId: SHOP_ID,
      userId: CAROL_ID,
      status: REVIEW_STATUS_HIDDEN,
      createdAtMs: 30,
    });
    await seedReview(world, {
      id: 'rev_other_shop',
      shopId: OTHER_SHOP_ID,
      userId: ALICE_ID,
      status: REVIEW_STATUS_PUBLISHED,
      createdAtMs: 40,
    });
    await seedReview(world, {
      id: 'rev_deleted',
      shopId: OTHER_SHOP_ID,
      userId: BOB_ID,
      status: REVIEW_STATUS_DELETED,
      createdAtMs: 50,
    });
    db = createDatabase(world.d1);
  });

  afterEach(async () => {
    await world.dispose();
  });

  describe('listVisibleReviews', () => {
    it('指定した店舗の published なレビューだけを返す', async () => {
      const rows = await listVisibleReviews(db, alice, toShopId(SHOP_ID));
      expect(rows.map((row) => row.id).sort()).toEqual(['rev_alice', 'rev_bob']);
    });

    it('別の店舗のレビューを混ぜない', async () => {
      const rows = await listVisibleReviews(db, alice, toShopId(SHOP_ID));
      expect(rows.map((row) => row.id)).not.toContain('rev_other_shop');
    });

    it('hidden なレビューは投稿者本人にも見せない', async () => {
      // 本人にだけ見えると「伏せられた」と分かり、通報されたこと自体が漏れる
      const rows = await listVisibleReviews(db, carol, toShopId(SHOP_ID));
      expect(rows.map((row) => row.id)).not.toContain('rev_hidden');
    });

    it('admin には hidden も見せる（通報対応のため）', async () => {
      const rows = await listVisibleReviews(db, admin, toShopId(SHOP_ID));
      expect(rows.map((row) => row.id).sort()).toEqual(['rev_alice', 'rev_bob', 'rev_hidden']);
    });

    it('admin にも deleted は見せない', async () => {
      const rows = await listVisibleReviews(db, admin, toShopId(OTHER_SHOP_ID));
      expect(rows.map((row) => row.id)).toEqual(['rev_other_shop']);
    });

    it('新しい順に並ぶ', async () => {
      const rows = await listVisibleReviews(db, admin, toShopId(SHOP_ID));
      expect(rows.map((row) => row.id)).toEqual(['rev_hidden', 'rev_bob', 'rev_alice']);
    });

    it('レビューが 1 件も無い店舗では空配列を返す（例外にしない）', async () => {
      const rows = await listVisibleReviews(db, alice, toShopId(EMPTY_SHOP_ID));
      expect(rows).toEqual([]);
    });
  });

  describe('createReviewAsUser', () => {
    it('投稿者の userId が記録される', async () => {
      const created = await createReviewAsUser(
        db,
        alice,
        toShopId(EMPTY_SHOP_ID),
        toReviewId('rev_new'),
        NEW_REVIEW_INPUT,
        new Date(100),
      );
      expect(created.userId).toBe(ALICE_ID);
      expect(created.status).toBe(REVIEW_STATUS_PUBLISHED);
    });

    it('引数の userId を受け取らない（なりすましの経路を作らない）', async () => {
      // シグネチャに userId が無いことを型で保証している。ここでは値の出所だけ確認する
      const created = await createReviewAsUser(
        db,
        bob,
        toShopId(EMPTY_SHOP_ID),
        toReviewId('rev_new2'),
        NEW_REVIEW_INPUT,
        new Date(110),
      );
      expect(created.userId).toBe(BOB_ID);
    });

    it('入力の shopId ではなく引数の shopId を保存する', async () => {
      // 入力の shopId は shp_a。引数には別店舗を渡す。保存されるのは引数側
      const created = await createReviewAsUser(
        db,
        alice,
        toShopId(EMPTY_SHOP_ID),
        toReviewId('rev_new3'),
        NEW_REVIEW_INPUT,
        new Date(120),
      );
      expect(created.shopId).toBe(EMPTY_SHOP_ID);
    });

    it('budgetYen を budget 列へ対応づける', async () => {
      const created = await createReviewAsUser(
        db,
        alice,
        toShopId(EMPTY_SHOP_ID),
        toReviewId('rev_new4'),
        NEW_REVIEW_INPUT,
        new Date(130),
      );
      expect(created.budget).toBe(3200);
    });

    it('budgetYen が null なら budget も null', async () => {
      const created = await createReviewAsUser(
        db,
        alice,
        toShopId(EMPTY_SHOP_ID),
        toReviewId('rev_new5'),
        { ...NEW_REVIEW_INPUT, budgetYen: null },
        new Date(140),
      );
      expect(created.budget).toBeNull();
    });

    it('visitedOn を ISO 日付文字列のまま保存する', async () => {
      const created = await createReviewAsUser(
        db,
        alice,
        toShopId(EMPTY_SHOP_ID),
        toReviewId('rev_new6'),
        NEW_REVIEW_INPUT,
        new Date(150),
      );
      expect(created.visitedOn).toBe('2026-09-10');
    });

    it('createdAt を Date のまま返す（timestamp_ms なので整数ではない）', async () => {
      const created = await createReviewAsUser(
        db,
        alice,
        toShopId(EMPTY_SHOP_ID),
        toReviewId('rev_new7'),
        NEW_REVIEW_INPUT,
        new Date(160),
      );
      expect(created.createdAt).toEqual(new Date(160));
    });

    it('作成直後は published なので一覧に載る', async () => {
      await createReviewAsUser(
        db,
        alice,
        toShopId(EMPTY_SHOP_ID),
        toReviewId('rev_new8'),
        NEW_REVIEW_INPUT,
        new Date(170),
      );
      const rows = await listVisibleReviews(db, bob, toShopId(EMPTY_SHOP_ID));
      expect(rows.map((row) => row.id)).toContain('rev_new8');
    });

    it('同じ利用者が同じ店に 2 件目を投稿すると一意制約で落ちる', async () => {
      // alice は shp_a に rev_alice を投稿済み。DB 側の uq_reviews_shop_user が効いている証拠
      const message = await rejectionMessageOf(
        createReviewAsUser(
          db,
          alice,
          toShopId(SHOP_ID),
          toReviewId('rev_dup'),
          NEW_REVIEW_INPUT,
          new Date(180),
        ),
      );
      expect(message).toContain('UNIQUE constraint failed: reviews.shop_id, reviews.user_id');
    });

    it('存在しない店舗 ID では外部キー制約で落ちる', async () => {
      const message = await rejectionMessageOf(
        createReviewAsUser(
          db,
          alice,
          toShopId('shp_nothing'),
          toReviewId('rev_fk'),
          NEW_REVIEW_INPUT,
          new Date(190),
        ),
      );
      expect(message).toContain('FOREIGN KEY constraint failed');
    });
  });

  describe('deleteReviewAsAuthor', () => {
    it('自分のレビューを削除できる', async () => {
      expect(await deleteReviewAsAuthor(db, alice, toReviewId('rev_alice'))).toBe(true);
    });

    it('他人のレビューは削除できない（false）', async () => {
      expect(await deleteReviewAsAuthor(db, alice, toReviewId('rev_bob'))).toBe(false);
    });

    it('他人のレビューの行が残っている', async () => {
      await deleteReviewAsAuthor(db, alice, toReviewId('rev_bob'));

      // リポジトリを通さず生 SQL で実体を見る。false が返っても消えていた、を検出するため
      const row = await readRow(world, 'SELECT id FROM reviews WHERE id = ?', 'rev_bob');

      expect(row).toEqual({ id: 'rev_bob' });
    });

    it('存在しない ID でも false（他人のレビューと同じ結果）', async () => {
      expect(await deleteReviewAsAuthor(db, alice, toReviewId('rev_nothing'))).toBe(false);
    });

    it('自分の hidden なレビューも削除できる（見えないが自分のものではある）', async () => {
      expect(await deleteReviewAsAuthor(db, carol, toReviewId('rev_hidden'))).toBe(true);
    });
  });

  describe('deleteReviewAsAdmin', () => {
    it('他人のレビューでも削除できる', async () => {
      expect(await deleteReviewAsAdmin(db, admin, toReviewId('rev_bob'))).toBe(true);
    });

    it('存在しない ID には false を返す', async () => {
      expect(await deleteReviewAsAdmin(db, admin, toReviewId('rev_nothing'))).toBe(false);
    });

    it('削除対象以外を消さない', async () => {
      await deleteReviewAsAdmin(db, admin, toReviewId('rev_bob'));
      expect(await countRows(world, 'SELECT COUNT(*) AS count FROM reviews')).toBe(4);
    });
  });
});
