import { ROLE_ADMIN, ROLE_OWNER, ROLE_USER } from '@meshimap/core';
import type { Role } from '@meshimap/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_BASE_PATH } from '../auth/auth';
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

// ───────────────── ルート表 ↔ 実装の突合（Task 4-14）─────────────────

/** `app.routes` の 1 要素から、突合に必要な 2 つだけを抜き出した形 */
type RegisteredRoute = { readonly method: string; readonly path: string };

/** 走査対象が 0 本のときに返す違反。これが無いと「表も実装も空」で偽の緑になる */
const VIOLATION_NO_SCAN_TARGET = '走査対象のエンドポイントが 1 本も無い';

/**
 * `.use()` で登録したミドルウェアか。
 *
 * Hono は `.use('*', mw)` も `app.all('/x', h)` も method を 'ALL' として記録するため、
 * method だけでは区別できない。ワイルドカードで終わるパスだけをミドルウェアとみなす。
 * こうしないと `app.all('/version', ...)` のような**本物のエンドポイントが
 * 静かに突合から漏れる**。`.use('/admin', mw)` のようなワイルドカード無しの登録は
 * エンドポイント扱いになって突合に失敗するが、**黙って見逃すより落ちる側に倒す**。
 */
function isMiddlewareRoute(route: RegisteredRoute): boolean {
  return route.method === 'ALL' && route.path.endsWith('*');
}

/**
 * Better Auth のハンドラ配下か。権限は Better Auth 側の責務なのでマトリクスの対象外にする。
 *
 * 単なる前方一致で判定してはいけない。`AUTH_BASE_PATH` が `/api/auth` のとき、
 * `startsWith` だけだと `/api/authorize` のような**別のエンドポイントまで巻き込んで除外**する。
 * パス境界（完全一致か、直後が `/`）まで見る。
 */
function isAuthHandlerRoute(route: RegisteredRoute, authBasePath: string): boolean {
  return route.path === authBasePath || route.path.startsWith(`${authBasePath}/`);
}

/**
 * 登録済みルートから「権限マトリクスが責任を持つエンドポイント」を取り出す。
 * ミドルウェアとハンドラで同じ method + path が重複して現れるので Set で潰す。
 */
export function collectEndpointPatterns(
  routes: readonly RegisteredRoute[],
  authBasePath: string,
): readonly string[] {
  const patterns = routes
    .filter((route) => !isMiddlewareRoute(route) && !isAuthHandlerRoute(route, authBasePath))
    .map((route) => `${route.method} ${route.path}`);
  return [...new Set(patterns)].sort();
}

/**
 * ルート表（権限マトリクス）と実装を突き合わせ、食い違いを文字列で列挙する純関数。
 * 空配列が返れば「表と実装が 1 本残らず一致している」。
 */
export function collectRouteCoverageViolations(
  routes: readonly RegisteredRoute[],
  coveredPatterns: readonly string[],
  authBasePath: string,
): readonly string[] {
  const declared = collectEndpointPatterns(routes, authBasePath);
  if (declared.length === 0) {
    return [VIOLATION_NO_SCAN_TARGET];
  }
  const covered = [...new Set(coveredPatterns)].sort();
  const violations: string[] = [];
  for (const pattern of declared) {
    if (!covered.includes(pattern)) {
      violations.push(`権限マトリクスに無いエンドポイント: ${pattern}`);
    }
  }
  for (const pattern of covered) {
    if (!declared.includes(pattern)) {
      violations.push(`実装に無いエンドポイント: ${pattern}`);
    }
  }
  return violations;
}

/**
 * `app.routes` に実際に載っているルート。実測した内訳は次のとおり。
 * - 生の要素数 22（ミドルウェアとハンドラで同じ method + path が重複して現れる）
 * - 重複を潰すと 13
 * - そこから `ALL /*`（authMiddleware）と `GET|POST /api/auth/*`（Better Auth）を除くと 10
 */
function declaredRoutePatterns(): readonly string[] {
  return collectEndpointPatterns(app.routes, AUTH_BASE_PATH);
}

/** 権限マトリクスが責任を持つ 10 本。ここを増減させるときは必ず ENDPOINT_CASES も直す */
const EXPECTED_ROUTE_PATTERNS: readonly string[] = [
  'DELETE /reviews/:reviewId',
  'DELETE /shops/:shopId',
  'GET /health',
  'GET /me',
  'GET /shops',
  'GET /shops/:shopId',
  'GET /shops/:shopId/reviews',
  'PATCH /shops/:shopId',
  'POST /shops',
  'POST /shops/:shopId/reviews',
];

describe('突合器そのものの取りこぼし', () => {
  const AUTH_BASE = '/api/auth';
  const SAMPLE_ROUTES: readonly RegisteredRoute[] = [
    { method: 'ALL', path: '/*' },
    { method: 'GET', path: '/api/auth/*' },
    { method: 'POST', path: '/api/auth/*' },
    { method: 'GET', path: '/health' },
    { method: 'GET', path: '/health' },
  ];

  it('表と実装が一致していれば違反は無い', () => {
    expect(collectRouteCoverageViolations(SAMPLE_ROUTES, ['GET /health'], AUTH_BASE)).toEqual([]);
  });

  it('ミドルウェア（ALL + ワイルドカード）はエンドポイントに数えない', () => {
    expect(collectEndpointPatterns(SAMPLE_ROUTES, AUTH_BASE)).toEqual(['GET /health']);
  });

  it('ワイルドカードを持たない ALL は本物のエンドポイントとして数える', () => {
    // app.all('/version', ...) を「ミドルウェアだから」と見逃すと突合が素通りする
    const routes = [...SAMPLE_ROUTES, { method: 'ALL', path: '/version' }];
    expect(collectRouteCoverageViolations(routes, ['GET /health'], AUTH_BASE)).toEqual([
      '権限マトリクスに無いエンドポイント: ALL /version',
    ]);
  });

  it('Better Auth 配下は除外するが、前方一致だけの別パスは除外しない', () => {
    // '/api/authorize' は '/api/auth' で startsWith が真になる。境界を見ないと黙って消える
    const routes = [...SAMPLE_ROUTES, { method: 'GET', path: '/api/authorize' }];
    expect(collectRouteCoverageViolations(routes, ['GET /health'], AUTH_BASE)).toEqual([
      '権限マトリクスに無いエンドポイント: GET /api/authorize',
    ]);
  });

  it('AUTH_BASE_PATH と完全一致するパスも除外する', () => {
    const routes = [...SAMPLE_ROUTES, { method: 'POST', path: '/api/auth' }];
    expect(collectEndpointPatterns(routes, AUTH_BASE)).toEqual(['GET /health']);
  });

  it('実装に足されたエンドポイントを検出する', () => {
    const routes = [...SAMPLE_ROUTES, { method: 'GET', path: '/version' }];
    expect(collectRouteCoverageViolations(routes, ['GET /health'], AUTH_BASE)).toEqual([
      '権限マトリクスに無いエンドポイント: GET /version',
    ]);
  });

  it('表にだけあって実装に無いエンドポイントを検出する', () => {
    expect(
      collectRouteCoverageViolations(SAMPLE_ROUTES, ['GET /health', 'GET /healthz'], AUTH_BASE),
    ).toEqual(['実装に無いエンドポイント: GET /healthz']);
  });

  it('パスが同じでもメソッドが違えば別のエンドポイントとして扱う', () => {
    const routes = [...SAMPLE_ROUTES, { method: 'POST', path: '/health' }];
    expect(collectRouteCoverageViolations(routes, ['GET /health'], AUTH_BASE)).toEqual([
      '権限マトリクスに無いエンドポイント: POST /health',
    ]);
  });

  it('同じ method + path が何度現れても 1 本に潰れる', () => {
    // ミドルウェアとハンドラで同じ行が重複して載るため、潰さないと件数が合わない
    const routes = [
      { method: 'GET', path: '/health' },
      { method: 'GET', path: '/health' },
      { method: 'GET', path: '/health' },
    ];
    expect(collectEndpointPatterns(routes, AUTH_BASE)).toEqual(['GET /health']);
  });

  it('表の側に重複があっても違反にならない（#4 と #5 のように 1 本を複数ケースで検証する）', () => {
    expect(
      collectRouteCoverageViolations(SAMPLE_ROUTES, ['GET /health', 'GET /health'], AUTH_BASE),
    ).toEqual([]);
  });

  it('入力の並び順が変わっても結果は変わらない', () => {
    const shuffled = [...SAMPLE_ROUTES].reverse();
    expect(collectEndpointPatterns(shuffled, AUTH_BASE)).toEqual(
      collectEndpointPatterns(SAMPLE_ROUTES, AUTH_BASE),
    );
  });

  it('走査対象が 0 本なら、表も空でも違反として報告する（偽の緑を防ぐ）', () => {
    // ここが無いと「ルートが 1 本も取れていない」状態が「全部覆えている」に見える
    expect(collectRouteCoverageViolations([], [], AUTH_BASE)).toEqual([VIOLATION_NO_SCAN_TARGET]);
    expect(collectRouteCoverageViolations([{ method: 'ALL', path: '/*' }], [], AUTH_BASE)).toEqual([
      VIOLATION_NO_SCAN_TARGET,
    ]);
  });

  it('表が空なら実装の全エンドポイントが未検証として並ぶ', () => {
    expect(collectRouteCoverageViolations(SAMPLE_ROUTES, [], AUTH_BASE)).toEqual([
      '権限マトリクスに無いエンドポイント: GET /health',
    ]);
  });
});

describe('ルート表と実装の突合', () => {
  it('走査対象のエンドポイントが 1 本以上ある', () => {
    // 0 本なら以降の比較は「空 vs 空」で必ず通ってしまう。先に本数を押さえる
    expect(declaredRoutePatterns().length).toBeGreaterThan(0);
  });

  it('app に登録されたエンドポイントは 10 本で、想定どおりの並びである', () => {
    expect(declaredRoutePatterns()).toEqual(EXPECTED_ROUTE_PATTERNS);
  });

  it('権限マトリクスは app のエンドポイントを 1 本残らず覆っている', () => {
    // #4 と #5 のように 1 本のルートを複数ケースで検証しているので、重複は潰して比べる
    const covered = ENDPOINT_CASES.map((endpoint) => endpoint.routePattern);
    expect(collectRouteCoverageViolations(app.routes, covered, AUTH_BASE_PATH)).toEqual([]);
  });
});
