import {
  ROLE_ADMIN,
  ROLE_OWNER,
  ROLE_USER,
  reviewCreateSchema,
  shopCreateSchema,
  shopUpdateSchema,
  toUserId,
} from '@meshimap/core';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { isAdminActor } from '../auth/actor';
import { createDatabase } from '../db/client';
import type { AppEnv } from '../lib/app-env';
import { invalidInput, notFound } from '../lib/http-error';
import { generateReviewId, generateShopId, parseShopId } from '../lib/parse-id';
import { jsonBody } from '../lib/validate';
import {
  requireAdminActor,
  requireOwnerActor,
  requireUserActor,
  roleGuard,
} from '../middleware/role-guard';
import { createReviewAsUser, listVisibleReviews } from '../repositories/review-repository';
import {
  createShopAsAdmin,
  deleteShopAsAdmin,
  findVisibleShop,
  listVisibleShops,
  updateShopAsAdmin,
  updateShopAsOwner,
} from '../repositories/shop-repository';

/**
 * 店舗の所有者。shopCreateSchema には ownerId が無く、packages/core は Phase 4 で編集できないため、
 * クエリパラメータとして受ける。toUserId を通すので不正な形式は 422 になる。
 */
function ownerIdQuery() {
  return validator('query', (value) => {
    const raw = value['ownerId'];
    if (typeof raw !== 'string') {
      throw invalidInput();
    }
    try {
      return { ownerId: toUserId(raw) };
    } catch {
      throw invalidInput();
    }
  });
}

export const shopRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const db = createDatabase(c.env.DB);
    // viewer をそのまま渡す。誰に何が見えるかはリポジトリの WHERE 句が決める
    const shops = await listVisibleShops(db, c.get('viewer'));
    return c.json({ shops });
  })
  .post('/', roleGuard(ROLE_ADMIN), ownerIdQuery(), jsonBody(shopCreateSchema), async (c) => {
    const actor = requireAdminActor(c);
    const db = createDatabase(c.env.DB);
    const input = c.req.valid('json');
    const { ownerId } = c.req.valid('query');
    const shop = await createShopAsAdmin(db, actor, input, ownerId, generateShopId(), new Date());
    return c.json({ shop }, 201);
  })
  .get('/:shopId', async (c) => {
    const db = createDatabase(c.env.DB);
    const shop = await findVisibleShop(db, c.get('viewer'), parseShopId(c.req.param('shopId')));
    if (shop === null) {
      // 「見えない」も「存在しない」も同じ 404。区別する情報をここは持っていない
      throw notFound();
    }
    return c.json({ shop });
  })
  .patch('/:shopId', roleGuard(ROLE_OWNER, ROLE_ADMIN), jsonBody(shopUpdateSchema), async (c) => {
    const db = createDatabase(c.env.DB);
    const shopId = parseShopId(c.req.param('shopId'));
    const input = c.req.valid('json');
    // 緯度と経度は必ず対で受け取る。片方だけ更新すると geohash が実座標とずれる
    if ((input.latitude === undefined) !== (input.longitude === undefined)) {
      throw invalidInput();
    }
    const viewer = c.get('viewer');
    // ロールで「どちらの関数を呼ぶか」を選ぶだけ。権限判定そのものは各関数の WHERE 句が行う
    const shop = isAdminActor(viewer)
      ? await updateShopAsAdmin(db, requireAdminActor(c), shopId, input, new Date())
      : await updateShopAsOwner(db, requireOwnerActor(c), shopId, input, new Date());
    if (shop === null) {
      throw notFound();
    }
    return c.json({ shop });
  })
  .delete('/:shopId', roleGuard(ROLE_ADMIN), async (c) => {
    const db = createDatabase(c.env.DB);
    const isDeleted = await deleteShopAsAdmin(
      db,
      requireAdminActor(c),
      parseShopId(c.req.param('shopId')),
    );
    if (!isDeleted) {
      throw notFound();
    }
    return c.body(null, 204);
  })
  .get('/:shopId/reviews', async (c) => {
    const db = createDatabase(c.env.DB);
    const reviews = await listVisibleReviews(
      db,
      c.get('viewer'),
      parseShopId(c.req.param('shopId')),
    );
    return c.json({ reviews });
  })
  .post('/:shopId/reviews', roleGuard(ROLE_USER), jsonBody(reviewCreateSchema), async (c) => {
    const actor = requireUserActor(c);
    const db = createDatabase(c.env.DB);
    const shopId = parseShopId(c.req.param('shopId'));
    const input = c.req.valid('json');
    // URL とボディで店舗が食い違うリクエストは通さない
    if (input.shopId !== shopId) {
      throw invalidInput();
    }
    // 見えない店舗へレビューを差し込めないよう、投稿前に可視性を確認する
    const shop = await findVisibleShop(db, actor, shopId);
    if (shop === null) {
      throw notFound();
    }
    const review = await createReviewAsUser(
      db,
      actor,
      shopId,
      generateReviewId(),
      input,
      new Date(),
    );
    return c.json({ review }, 201);
  });
