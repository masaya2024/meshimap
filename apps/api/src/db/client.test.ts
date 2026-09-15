import { DrizzleQueryError, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './client';
import { LATITUDE_MAX, SHOP_STATUS_DRAFT } from './constants';
import { areas, genres, shops, user } from './schema';
import { createMigratedD1, type LocalD1 } from './testing/local-d1';

/** テストデータの ID。期待値にも出るため定数にしておく */
const GENRE_ID = 'gnr_client';
const AREA_ID = 'area_client';
const SHOP_ID = 'shp_client';
const OUT_OF_RANGE_SHOP_ID = 'shp_client_ng';
const UNVERIFIED_USER_ID = 'usr_client_unverified';
const VERIFIED_USER_ID = 'usr_client_verified';

/** batch で 1 往復にまとめて入れるジャンル */
const BATCH_GENRE_IDS = ['gnr_batch_sushi', 'gnr_batch_yakiniku'] as const;

const SHOP_NAME = 'クライアントテスト店';

/** 渋谷駅の座標と、その precision 7 の geohash（packages/geo の encodeGeohash で算出した値） */
const SHIBUYA = { lat: 35.658034, lng: 139.701636, geohash: 'xn76fgr' } as const;

/** CHECK 制約 ck_shops_lat に必ず引っかかる緯度。上限を 1 度超える */
const OUT_OF_RANGE_LATITUDE = LATITUDE_MAX + 1;

/** 緯度の CHECK に引っかかったときに SQLite が返すメッセージ */
const LATITUDE_CHECK_VIOLATION_PATTERN = /CHECK constraint failed: ck_shops_lat/;

/** 失敗するはずの Drizzle 操作を実行し、投げられた例外そのものを返す */
async function captureRejection(operation: PromiseLike<unknown>): Promise<unknown> {
  return operation.then(
    () => undefined,
    (error: unknown) => error,
  );
}

let local: LocalD1;
let database: Database;

beforeAll(async () => {
  local = await createMigratedD1();
  database = createDatabase(local.d1);
});

afterAll(async () => {
  await local.dispose();
});

describe('createDatabase', () => {
  it('Drizzle 経由で INSERT と SELECT ができる', async () => {
    await database.insert(genres).values({ id: GENRE_ID, name: 'ラーメン', slug: 'ramen-client' });
    await database.insert(areas).values({ id: AREA_ID, name: '渋谷', prefecture: '東京都' });
    await database.insert(shops).values({
      id: SHOP_ID,
      name: SHOP_NAME,
      genreId: GENRE_ID,
      areaId: AREA_ID,
      address: '東京都渋谷区',
      lat: SHIBUYA.lat,
      lng: SHIBUYA.lng,
      geohash: SHIBUYA.geohash,
    });

    const rows = await database.select().from(shops).where(eq(shops.id, SHOP_ID));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe(SHOP_NAME);
  });

  it('timestamp_ms の列が Date として返る', async () => {
    const rows = await database.select().from(shops).where(eq(shops.id, SHOP_ID));

    // mode: 'timestamp_ms' は Drizzle が Date へ変換する。生の数値ではない
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('integer と text の列はそのままの型で返る', async () => {
    const rows = await database.select().from(shops).where(eq(shops.id, SHOP_ID));

    expect(typeof rows[0]?.ratingCount).toBe('number');
    expect(rows[0]?.status).toBe(SHOP_STATUS_DRAFT);
  });

  it('boolean の列が真偽値として返る', async () => {
    // SQLite に真偽値型はなく 0/1 で入る。mode: 'boolean' の変換が効いているかを見る
    await database.batch([
      database
        .insert(user)
        .values({ id: UNVERIFIED_USER_ID, name: '未認証', email: 'unverified@example.com' }),
      database.insert(user).values({
        id: VERIFIED_USER_ID,
        name: '認証済み',
        email: 'verified@example.com',
        emailVerified: true,
      }),
    ]);

    const rows = await database
      .select()
      .from(user)
      .where(inArray(user.id, [UNVERIFIED_USER_ID, VERIFIED_USER_ID]));
    const emailVerifiedById = new Map(rows.map((row) => [row.id, row.emailVerified]));

    expect(emailVerifiedById.get(UNVERIFIED_USER_ID)).toBe(false);
    expect(emailVerifiedById.get(VERIFIED_USER_ID)).toBe(true);
  });

  it('CHECK 違反は Drizzle 経由でも例外になる（原因は cause 側に入る）', async () => {
    const thrown = await captureRejection(
      database.insert(shops).values({
        id: OUT_OF_RANGE_SHOP_ID,
        name: '緯度が範囲外の店',
        genreId: GENRE_ID,
        areaId: AREA_ID,
        address: '東京都渋谷区',
        lat: OUT_OF_RANGE_LATITUDE,
        lng: SHIBUYA.lng,
        geohash: SHIBUYA.geohash,
      }),
    );

    // Drizzle は D1 の例外を DrizzleQueryError で包む。外側のメッセージは SQL と
    // バインド値だけで、どの CHECK に違反したかは cause にしか出ない。
    // Phase 4 以降でエラーを分類するときは cause を辿ること。
    expect(thrown).toBeInstanceOf(DrizzleQueryError);
    const cause = thrown instanceof Error ? thrown.cause : undefined;
    expect(cause).toBeInstanceOf(Error);
    expect(cause instanceof Error ? cause.message : '').toMatch(LATITUDE_CHECK_VIOLATION_PATTERN);
  });

  it('batch で複数文を 1 往復にまとめられる', async () => {
    // D1 の batch は 1 トランザクション。Phase 7 の予約確定で使う
    await database.batch([
      database.insert(genres).values({ id: BATCH_GENRE_IDS[0], name: '寿司', slug: 'sushi-batch' }),
      database
        .insert(genres)
        .values({ id: BATCH_GENRE_IDS[1], name: '焼肉', slug: 'yakiniku-batch' }),
    ]);

    const rows = await database
      .select()
      .from(genres)
      .where(inArray(genres.id, [...BATCH_GENRE_IDS]));

    expect(rows.map((row) => row.id).sort()).toEqual([...BATCH_GENRE_IDS].sort());
  });

  it('schema を渡しているのでリレーショナルクエリが使える', async () => {
    // drizzle(d1) だけだと database.query が空になり、この呼び出しが実行時に壊れる。
    // client.ts が schema を渡し続けていることの実行時の担保。
    const shop = await database.query.shops.findFirst({ where: eq(shops.id, SHOP_ID) });

    expect(shop?.name).toBe(SHOP_NAME);
  });
});
