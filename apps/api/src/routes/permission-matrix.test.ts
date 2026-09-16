import { ROLE_ADMIN, ROLE_OWNER, ROLE_USER } from '@meshimap/core';
import type { Role } from '@meshimap/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHOP_STATUS_DRAFT, SHOP_STATUS_PUBLISHED } from '../db/constants';
import { app } from '../index';
import type { TestWorld } from '../test/fixtures';
import {
  createTestBindings,
  createTestWorld,
  seedMasters,
  seedReview,
  seedShop,
  seedUser,
  signUpAs,
  TEST_AREA_ID,
  TEST_GENRE_ID,
} from '../test/fixtures';

/**
 * 閲覧者の種類。'anonymous' は Cookie を送らない＝未認証。
 * Role をそのまま使うので、@meshimap/core にロールが増えたらここがコンパイルエラーになり、
 * マトリクスの更新漏れに気付ける。
 */
type ViewerKind = 'anonymous' | Role;

const VIEWER_KINDS: readonly ViewerKind[] = ['anonymous', ROLE_USER, ROLE_OWNER, ROLE_ADMIN];

const BASE_URL = 'http://localhost:8787';

/**
 * 閲覧者以外の第三者。所有者・投稿者としてシードに使う。
 * user テーブルへの外部キーがあるので、**3 人とも本当に user 行を作る**。
 */
const OTHER_OWNER_ID = 'usr_other_owner';
const OTHER_AUTHOR_ID = 'usr_other_author';
/** rev_other の投稿者。uq_reviews_shop_user を避けるため rev_mine とは必ず別人にする */
const SECOND_AUTHOR_ID = 'usr_second_author';

const SHOP_MINE_ID = 'shp_mine';
const SHOP_OTHER_DRAFT_ID = 'shp_other_draft';
/** #11 の投稿先。レビューを 1 件も持たせない（同じ利用者の二重投稿を避けるため） */
const SHOP_REVIEWABLE_ID = 'shp_reviewable';
const REVIEW_MINE_ID = 'rev_mine';
const REVIEW_OTHER_ID = 'rev_other';

/** shopCreateSchema を満たす最小のボディ。genre / area は seedMasters が入れた実在の ID */
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

const NEW_REVIEW_BODY = {
  shopId: SHOP_REVIEWABLE_ID,
  rating: 5,
  body: 'とても良かった',
  visitedOn: '2026-09-10',
  budgetYen: 3200,
};

type EndpointCase = {
  readonly no: number;
  readonly label: string;
  readonly method: string;
  readonly path: string;
  /**
   * Hono に登録されるルートパターン（`app.routes` の `method` + `path` と同じ形）。
   * Task 4-14 でここと `app.routes` を突き合わせ、**表に無いエンドポイント**を機械的に検出する。
   */
  readonly routePattern: string;
  readonly body?: unknown;
  /** 閲覧者ごとの期待ステータス */
  readonly expected: Readonly<Record<ViewerKind, number>>;
};

/**
 * 計画書冒頭の権限マトリクスをそのままデータにしたもの。
 * 表を更新したらここも更新する。ここに無いエンドポイントは Task 4-14 の突き合わせで検出する。
 */
const ENDPOINT_CASES: readonly EndpointCase[] = [
  {
    no: 1,
    label: 'GET /health',
    method: 'GET',
    path: '/health',
    routePattern: 'GET /health',
    expected: { anonymous: 200, user: 200, owner: 200, admin: 200 },
  },
  {
    no: 2,
    label: 'GET /me',
    method: 'GET',
    path: '/me',
    routePattern: 'GET /me',
    expected: { anonymous: 401, user: 200, owner: 200, admin: 200 },
  },
  {
    no: 3,
    label: 'GET /shops',
    method: 'GET',
    path: '/shops',
    routePattern: 'GET /shops',
    expected: { anonymous: 200, user: 200, owner: 200, admin: 200 },
  },
  {
    no: 4,
    label: 'GET /shops/:shopId（published）',
    method: 'GET',
    path: `/shops/${SHOP_MINE_ID}`,
    routePattern: 'GET /shops/:shopId',
    expected: { anonymous: 200, user: 200, owner: 200, admin: 200 },
  },
  {
    no: 5,
    label: 'GET /shops/:shopId（他人の draft）',
    method: 'GET',
    path: `/shops/${SHOP_OTHER_DRAFT_ID}`,
    routePattern: 'GET /shops/:shopId',
    expected: { anonymous: 404, user: 404, owner: 404, admin: 200 },
  },
  {
    no: 6,
    label: 'POST /shops',
    method: 'POST',
    path: `/shops?ownerId=${OTHER_OWNER_ID}`,
    routePattern: 'POST /shops',
    body: NEW_SHOP_BODY,
    expected: { anonymous: 401, user: 403, owner: 403, admin: 201 },
  },
  {
    no: 7,
    label: 'PATCH /shops/:shopId（owner から見て自分の店舗）',
    method: 'PATCH',
    path: `/shops/${SHOP_MINE_ID}`,
    routePattern: 'PATCH /shops/:shopId',
    body: { name: '改名後' },
    expected: { anonymous: 401, user: 403, owner: 200, admin: 200 },
  },
  {
    no: 8,
    label: 'PATCH /shops/:shopId（他人の店舗）',
    method: 'PATCH',
    path: `/shops/${SHOP_OTHER_DRAFT_ID}`,
    routePattern: 'PATCH /shops/:shopId',
    body: { name: '乗っ取り' },
    expected: { anonymous: 401, user: 403, owner: 404, admin: 200 },
  },
  {
    no: 9,
    label: 'DELETE /shops/:shopId',
    method: 'DELETE',
    path: `/shops/${SHOP_MINE_ID}`,
    routePattern: 'DELETE /shops/:shopId',
    expected: { anonymous: 401, user: 403, owner: 403, admin: 204 },
  },
  {
    no: 10,
    label: 'GET /shops/:shopId/reviews',
    method: 'GET',
    path: `/shops/${SHOP_MINE_ID}/reviews`,
    routePattern: 'GET /shops/:shopId/reviews',
    expected: { anonymous: 200, user: 200, owner: 200, admin: 200 },
  },
  {
    no: 11,
    label: 'POST /shops/:shopId/reviews',
    method: 'POST',
    path: `/shops/${SHOP_REVIEWABLE_ID}/reviews`,
    routePattern: 'POST /shops/:shopId/reviews',
    body: NEW_REVIEW_BODY,
    expected: { anonymous: 401, user: 201, owner: 403, admin: 403 },
  },
  {
    no: 12,
    label: 'DELETE /reviews/:reviewId（user から見て自分の投稿）',
    method: 'DELETE',
    path: `/reviews/${REVIEW_MINE_ID}`,
    routePattern: 'DELETE /reviews/:reviewId',
    expected: { anonymous: 401, user: 204, owner: 403, admin: 204 },
  },
  {
    no: 13,
    label: 'DELETE /reviews/:reviewId（他人の投稿）',
    method: 'DELETE',
    path: `/reviews/${REVIEW_OTHER_ID}`,
    routePattern: 'DELETE /reviews/:reviewId',
    expected: { anonymous: 401, user: 404, owner: 403, admin: 204 },
  },
];

type Viewer = { readonly kind: ViewerKind; readonly cookie: string | null };

/**
 * 閲覧者を 1 人だけ用意し、その閲覧者から見た世界をシードする。
 *
 * - `shp_mine`: 閲覧者が owner ならその owner の店舗。それ以外なら第三者の店舗（どちらも published）
 * - `shp_other_draft`: 常に第三者の draft
 * - `shp_reviewable`: 常に第三者の published。レビューを付けない（#11 の投稿先）
 * - `rev_mine`: 閲覧者が user ならその user の投稿。それ以外なら `OTHER_AUTHOR_ID` の投稿
 * - `rev_other`: 常に `SECOND_AUTHOR_ID` の投稿
 *
 * `rev_other` を第三の利用者にしているのは、閲覧者が user 以外のとき
 * `rev_mine` と投稿者が一致して `uq_reviews_shop_user` に当たるのを避けるため。
 */
async function setUpWorld(world: TestWorld, kind: ViewerKind): Promise<Viewer> {
  await seedMasters(world);
  // 外部キー（shops.owner_id / reviews.user_id → user.id）を満たすため、第三者も本当に作る。
  // セッションが要らないので scrypt を通さない seedUser を使う
  await seedUser(world, { userId: OTHER_OWNER_ID, role: ROLE_OWNER });
  await seedUser(world, { userId: OTHER_AUTHOR_ID, role: ROLE_USER });
  await seedUser(world, { userId: SECOND_AUTHOR_ID, role: ROLE_USER });

  let cookie: string | null = null;
  let ownerId = OTHER_OWNER_ID;
  let authorId = OTHER_AUTHOR_ID;

  if (kind !== 'anonymous') {
    const signedUp = await signUpAs(world, `${kind}@example.com`, kind);
    cookie = signedUp.cookie;
    if (kind === ROLE_OWNER) {
      ownerId = signedUp.userId;
    }
    if (kind === ROLE_USER) {
      authorId = signedUp.userId;
    }
  }

  await seedShop(world, { id: SHOP_MINE_ID, ownerId, status: SHOP_STATUS_PUBLISHED });
  await seedShop(world, {
    id: SHOP_OTHER_DRAFT_ID,
    ownerId: OTHER_OWNER_ID,
    status: SHOP_STATUS_DRAFT,
  });
  await seedShop(world, {
    id: SHOP_REVIEWABLE_ID,
    ownerId: OTHER_OWNER_ID,
    status: SHOP_STATUS_PUBLISHED,
  });
  await seedReview(world, { id: REVIEW_MINE_ID, shopId: SHOP_MINE_ID, userId: authorId });
  await seedReview(world, {
    id: REVIEW_OTHER_ID,
    shopId: SHOP_MINE_ID,
    userId: SECOND_AUTHOR_ID,
  });

  return { kind, cookie };
}

function buildRequest(endpoint: EndpointCase, viewer: Viewer): Request {
  const headers: Record<string, string> = {};
  if (viewer.cookie !== null) {
    headers['cookie'] = viewer.cookie;
  }
  if (endpoint.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  return new Request(`${BASE_URL}${endpoint.path}`, {
    method: endpoint.method,
    headers,
    body: endpoint.body === undefined ? null : JSON.stringify(endpoint.body),
  });
}

describe('権限マトリクス（13 エンドポイント × 4 閲覧者）', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  for (const endpoint of ENDPOINT_CASES) {
    describe(`#${endpoint.no} ${endpoint.label}`, () => {
      for (const kind of VIEWER_KINDS) {
        it(`${kind} には ${endpoint.expected[kind]} を返す`, async () => {
          const viewer = await setUpWorld(world, kind);
          const res = await app.request(
            buildRequest(endpoint, viewer),
            undefined,
            createTestBindings(world),
          );
          expect(res.status).toBe(endpoint.expected[kind]);
        });
      }
    });
  }

  it('マトリクスは 13 エンドポイント × 4 閲覧者 = 52 通りを網羅している', () => {
    // ケースの取りこぼしを件数で検出する。表に行を足したらここも更新する
    expect(ENDPOINT_CASES).toHaveLength(13);
    expect(VIEWER_KINDS).toHaveLength(4);
    for (const endpoint of ENDPOINT_CASES) {
      expect(Object.keys(endpoint.expected).sort()).toEqual([
        'admin',
        'anonymous',
        'owner',
        'user',
      ]);
    }
  });

  it('エンドポイント番号が 1 から 13 まで重複なく並んでいる', () => {
    expect(ENDPOINT_CASES.map((endpoint) => endpoint.no)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
  });
});

describe('403 と 404 の使い分け', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('owner が触れない店舗と存在しない店舗で、応答が完全に一致する', async () => {
    const viewer = await setUpWorld(world, ROLE_OWNER);
    const headers = { 'content-type': 'application/json', cookie: viewer.cookie ?? '' };
    const forbiddenRes = await app.request(
      new Request(`${BASE_URL}/shops/${SHOP_OTHER_DRAFT_ID}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ name: '乗っ取り' }),
      }),
      undefined,
      createTestBindings(world),
    );
    const missingRes = await app.request(
      new Request(`${BASE_URL}/shops/shp_does_not_exist`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ name: '乗っ取り' }),
      }),
      undefined,
      createTestBindings(world),
    );
    expect(forbiddenRes.status).toBe(404);
    expect(missingRes.status).toBe(404);
    // ステータスだけでなく本文まで一致していること。差があれば存在有無が漏れる
    expect(await forbiddenRes.text()).toBe(await missingRes.text());
  });

  it('user が触れないレビューと存在しないレビューで、応答が完全に一致する', async () => {
    const viewer = await setUpWorld(world, ROLE_USER);
    const headers = { cookie: viewer.cookie ?? '' };
    const forbiddenRes = await app.request(
      `/reviews/${REVIEW_OTHER_ID}`,
      { method: 'DELETE', headers },
      createTestBindings(world),
    );
    const missingRes = await app.request(
      '/reviews/rev_does_not_exist',
      { method: 'DELETE', headers },
      createTestBindings(world),
    );
    expect(forbiddenRes.status).toBe(404);
    expect(missingRes.status).toBe(404);
    expect(await forbiddenRes.text()).toBe(await missingRes.text());
  });

  it('403 はリソース ID に依存しない（存在する ID でも存在しない ID でも同じ）', async () => {
    const viewer = await setUpWorld(world, ROLE_USER);
    const headers = { cookie: viewer.cookie ?? '' };
    const existingRes = await app.request(
      `/shops/${SHOP_MINE_ID}`,
      { method: 'DELETE', headers },
      createTestBindings(world),
    );
    const missingRes = await app.request(
      '/shops/shp_does_not_exist',
      { method: 'DELETE', headers },
      createTestBindings(world),
    );
    // roleGuard がリソースを読む前に弾くので、存在有無が応答に出ない
    expect(existingRes.status).toBe(403);
    expect(missingRes.status).toBe(403);
    expect(await existingRes.text()).toBe(await missingRes.text());
  });

  it('エラー応答にスタックトレース・SQL・テーブル名が含まれない', async () => {
    const viewer = await setUpWorld(world, ROLE_OWNER);
    const res = await app.request(
      new Request(`${BASE_URL}/shops/${SHOP_OTHER_DRAFT_ID}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: viewer.cookie ?? '' },
        body: JSON.stringify({ name: '乗っ取り' }),
      }),
      undefined,
      createTestBindings(world),
    );
    const text = await res.text();
    expect(text).toBe('{"error":{"status":404,"message":"対象が見つかりません"}}');
    expect(text).not.toMatch(/at\s+\w+\s+\(/);
    expect(text).not.toMatch(/select|update|delete\s+from|owner_id|shops|reviews/i);
  });
});
