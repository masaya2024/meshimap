import { toShopId, toUserId } from '@meshimap/core';
import type { ShopCreateInput } from '@meshimap/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANONYMOUS_VIEWER } from '../auth/actor';
import { createDatabase } from '../db/client';
import type { Database } from '../db/client';
import {
  ROLE_ADMIN,
  ROLE_OWNER,
  ROLE_USER,
  SHOP_STATUS_DRAFT,
  SHOP_STATUS_PUBLISHED,
} from '../db/constants';
import {
  adminActorOrThrow,
  buildActorForTest,
  createTestWorld,
  ownerActorOrThrow,
  readRow,
  runWrite,
  seedMasters,
  seedShop,
  seedUser,
  TEST_AREA_ID,
  TEST_GENRE_ID,
  TEST_LONGITUDE,
  userActorOrThrow,
} from '../test/fixtures';
import type { TestWorld } from '../test/fixtures';
import {
  createShopAsAdmin,
  deleteShopAsAdmin,
  findVisibleShop,
  listVisibleShops,
  updateShopAsAdmin,
  updateShopAsOwner,
} from './shop-repository';

const OWNER_A_ID = 'usr_owner_a';
const OWNER_B_ID = 'usr_owner_b';
const ADMIN_ID = 'usr_admin';
const USER_ID = 'usr_alice';

/** 渋谷駅付近（fixtures の既定座標）。precision 7 では xn76fgr */
const SEEDED_GEOHASH = 'xn76fgr';
/** 銀座 1-1-1。encodeGeohash(coordinate(35.6717, 139.765), 7) の実測値 */
const GINZA_GEOHASH = 'xn76umv';
/** 大阪駅。encodeGeohash(coordinate(34.702485, 135.495951), 7) の実測値 */
const OSAKA_GEOHASH = 'xn0m7m3';
const OSAKA_LATITUDE = 34.702485;
/** 差し替え先の master。genre_id / area_id が本当に書き換わったと言うには別の行が要る */
const OTHER_GENRE_ID = 'gnr_sushi';
const OTHER_AREA_ID = 'are_shinjuku';
const OSAKA_LONGITUDE = 135.495951;

/** shopCreateSchema.parse を通した後の形。default が適用済みなので全キーが揃っている */
const NEW_SHOP_INPUT: ShopCreateInput = {
  name: '新規店',
  nameKana: 'シンキテン',
  // genres / areas は ON DELETE restrict の外部キー。seedMasters が入れた ID しか使えない
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

describe('shop-repository', () => {
  let world: TestWorld;
  let db: Database;

  // buildActorForTest の戻りは Actor ユニオン。OwnerActor を要求する関数へは
  // 型ガードで絞ってからでないと渡せない。この一手間が必要なこと自体がブランド型が効いている証拠
  const ownerA = ownerActorOrThrow(buildActorForTest(OWNER_A_ID, ROLE_OWNER));
  const admin = adminActorOrThrow(buildActorForTest(ADMIN_ID, ROLE_ADMIN));
  const user = userActorOrThrow(buildActorForTest(USER_ID, ROLE_USER));

  beforeEach(async () => {
    world = await createTestWorld();
    await seedMasters(world);
    await seedUser(world, { userId: OWNER_A_ID, role: ROLE_OWNER });
    await seedUser(world, { userId: OWNER_B_ID, role: ROLE_OWNER });
    await seedUser(world, { userId: ADMIN_ID, role: ROLE_ADMIN });
    await seedUser(world, { userId: USER_ID, role: ROLE_USER });
    await seedShop(world, {
      id: 'shp_a_pub',
      ownerId: OWNER_A_ID,
      name: 'A の公開店',
      status: SHOP_STATUS_PUBLISHED,
      createdAtMs: 10,
      updatedAtMs: 10,
    });
    await seedShop(world, {
      id: 'shp_a_draft',
      ownerId: OWNER_A_ID,
      name: 'A の下書き店',
      status: SHOP_STATUS_DRAFT,
      createdAtMs: 20,
      updatedAtMs: 20,
    });
    await seedShop(world, {
      id: 'shp_b_pub',
      ownerId: OWNER_B_ID,
      name: 'B の公開店',
      status: SHOP_STATUS_PUBLISHED,
      createdAtMs: 30,
      updatedAtMs: 30,
    });
    await seedShop(world, {
      id: 'shp_b_draft',
      ownerId: OWNER_B_ID,
      name: 'B の下書き店',
      status: SHOP_STATUS_DRAFT,
      createdAtMs: 40,
      updatedAtMs: 40,
    });
    db = createDatabase(world.d1);
  });

  afterEach(async () => {
    await world.dispose();
  });

  describe('listVisibleShops', () => {
    it('user には published だけ見せる', async () => {
      const rows = await listVisibleShops(db, user);
      expect(rows.map((row) => row.id).sort()).toEqual(['shp_a_pub', 'shp_b_pub']);
    });

    it('匿名にも published だけ見せる', async () => {
      const rows = await listVisibleShops(db, ANONYMOUS_VIEWER);
      expect(rows.map((row) => row.id).sort()).toEqual(['shp_a_pub', 'shp_b_pub']);
    });

    it('owner には published と自分の draft を見せる', async () => {
      const rows = await listVisibleShops(db, ownerA);
      expect(rows.map((row) => row.id).sort()).toEqual(['shp_a_draft', 'shp_a_pub', 'shp_b_pub']);
    });

    it('owner に他人の draft を見せない', async () => {
      const rows = await listVisibleShops(db, ownerA);
      expect(rows.map((row) => row.id)).not.toContain('shp_b_draft');
    });

    it('owner_id が NULL の draft は owner からも見えない', async () => {
      // shops.owner_id は NULL 可（オーナー退会で set null される）。
      // `owner_id = ?` は NULL とは一致しないので、宙に浮いた店舗は誰のものにもならない
      await seedShop(world, { id: 'shp_orphan', ownerId: null, status: SHOP_STATUS_DRAFT });

      const rows = await listVisibleShops(db, ownerA);

      expect(rows.map((row) => row.id)).not.toContain('shp_orphan');
    });

    it('admin には全件見せる', async () => {
      const rows = await listVisibleShops(db, admin);
      expect(rows).toHaveLength(4);
    });

    it('新しい順（created_at の降順）に並ぶ', async () => {
      const rows = await listVisibleShops(db, admin);
      expect(rows.map((row) => row.id)).toEqual([
        'shp_b_draft',
        'shp_b_pub',
        'shp_a_draft',
        'shp_a_pub',
      ]);
    });

    it('limit で件数を絞れる', async () => {
      const rows = await listVisibleShops(db, admin, 2);
      expect(rows).toHaveLength(2);
    });

    it('limit に 0 を渡しても 1 件は返す（0 は結果が消えるので下限で丸める）', async () => {
      const rows = await listVisibleShops(db, admin, 0);
      expect(rows).toHaveLength(1);
    });

    it('limit に巨大な値を渡しても上限で丸める', async () => {
      const rows = await listVisibleShops(db, admin, 100000);
      expect(rows).toHaveLength(4);
    });
  });

  describe('findVisibleShop', () => {
    it('published は user から見える', async () => {
      const row = await findVisibleShop(db, user, toShopId('shp_a_pub'));
      expect(row?.id).toBe('shp_a_pub');
    });

    it('他人の draft は user から見えない（null）', async () => {
      const row = await findVisibleShop(db, user, toShopId('shp_a_draft'));
      expect(row).toBeNull();
    });

    it('自分の draft は owner から見える', async () => {
      const row = await findVisibleShop(db, ownerA, toShopId('shp_a_draft'));
      expect(row?.id).toBe('shp_a_draft');
    });

    it('他人の draft は owner から見えない（null）', async () => {
      const row = await findVisibleShop(db, ownerA, toShopId('shp_b_draft'));
      expect(row).toBeNull();
    });

    it('admin はどの draft も見える', async () => {
      const row = await findVisibleShop(db, admin, toShopId('shp_b_draft'));
      expect(row?.id).toBe('shp_b_draft');
    });

    it('存在しない ID は null（見えない draft と区別がつかない）', async () => {
      const missing = await findVisibleShop(db, ownerA, toShopId('shp_nothing'));
      const hidden = await findVisibleShop(db, ownerA, toShopId('shp_b_draft'));
      expect(missing).toBeNull();
      expect(hidden).toBeNull();
      expect(missing).toEqual(hidden);
    });
  });

  describe('updateShopAsOwner', () => {
    it('自分の店舗を更新できる', async () => {
      const updated = await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_a_pub'),
        { name: '改名後' },
        new Date(100),
      );
      expect(updated?.name).toBe('改名後');
      // timestamp_ms なので Drizzle からは Date で返る
      expect(updated?.updatedAt).toEqual(new Date(100));
    });

    it('他人の店舗を更新しようとすると null を返す', async () => {
      const updated = await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_b_pub'),
        { name: '乗っ取り' },
        new Date(100),
      );
      expect(updated).toBeNull();
    });

    it('他人の店舗の行は 1 バイトも変わらない', async () => {
      await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_b_pub'),
        { name: '乗っ取り' },
        new Date(100),
      );

      // リポジトリを通さず生 SQL で実体を見る。null が返っても書けていた、を検出するため
      const row = await readRow(
        world,
        'SELECT name, updated_at FROM shops WHERE id = ?',
        'shp_b_pub',
      );

      expect(row).toEqual({ name: 'B の公開店', updated_at: 30 });
    });

    it('存在しない ID でも null を返す（他人の店舗と同じ結果）', async () => {
      const updated = await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_nothing'),
        { name: 'x' },
        new Date(100),
      );
      expect(updated).toBeNull();
    });

    it('自分の draft も更新できる', async () => {
      const updated = await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_a_draft'),
        { name: '下書き改' },
        new Date(100),
      );
      expect(updated?.name).toBe('下書き改');
    });

    it('指定していない項目は書き換えない', async () => {
      const updated = await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_a_pub'),
        { name: '改名後' },
        new Date(100),
      );
      expect(updated?.address).toBe('東京都渋谷区道玄坂 1-1-1');
      expect(updated?.genreId).toBe(TEST_GENRE_ID);
    });

    it('更新項目が空でも updatedAt だけは進む', async () => {
      // ルート側は shopUpdateSchema の refine で空オブジェクトを 422 にするが、
      // リポジトリ単体では通る。set() が常に updatedAt を含むので SQL は成立する
      const updated = await updateShopAsOwner(db, ownerA, toShopId('shp_a_pub'), {}, new Date(200));
      expect(updated?.updatedAt).toEqual(new Date(200));
      expect(updated?.name).toBe('A の公開店');
    });

    it('緯度と経度を両方指定すると geohash を再計算する', async () => {
      const updated = await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_a_pub'),
        { latitude: OSAKA_LATITUDE, longitude: OSAKA_LONGITUDE },
        new Date(100),
      );
      expect(updated?.lat).toBe(OSAKA_LATITUDE);
      expect(updated?.lng).toBe(OSAKA_LONGITUDE);
      expect(updated?.geohash).toBe(OSAKA_GEOHASH);
    });

    it('緯度だけの指定では緯度も geohash も変えない', async () => {
      const updated = await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_a_pub'),
        { latitude: OSAKA_LATITUDE },
        new Date(100),
      );
      expect(updated?.lat).not.toBe(OSAKA_LATITUDE);
      expect(updated?.geohash).toBe(SEEDED_GEOHASH);
    });

    it('予算の Yen サフィックス付きプロパティを列名へ対応づける', async () => {
      const updated = await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_a_pub'),
        { budgetLunchMinYen: 800, budgetLunchMaxYen: 1500 },
        new Date(100),
      );
      expect(updated?.budgetLunchMin).toBe(800);
      expect(updated?.budgetLunchMax).toBe(1500);
    });

    it('任意項目をすべて指定すると、対応する列へ 1 つずつ書き込む', async () => {
      // genre_id / area_id は外部キー。別の値へ確かに変わったと言うために master をもう 1 組入れる
      await runWrite(
        world,
        'INSERT INTO genres (id, name, slug, icon_key, sort_order) VALUES (?, ?, ?, ?, ?)',
        OTHER_GENRE_ID,
        '寿司',
        'sushi',
        null,
        1,
      );
      await runWrite(
        world,
        'INSERT INTO areas (id, name, parent_id, prefecture) VALUES (?, ?, ?, ?)',
        OTHER_AREA_ID,
        '新宿',
        null,
        '東京都',
      );

      await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_a_pub'),
        {
          nameKana: 'エーノコウカイテン',
          genreId: OTHER_GENRE_ID,
          areaId: OTHER_AREA_ID,
          description: '説明を入れた',
          postalCode: '160-0022',
          address: '東京都新宿区新宿3-1-1',
          phone: '03-1234-5678',
          website: 'https://example.com',
          budgetDinnerMinYen: 3000,
          budgetDinnerMaxYen: 6000,
        },
        new Date(100),
      );

      // 戻り値ではなく生 SQL で見る。プロパティ名と列名の対応がずれていても
      // 戻り値どうしの比較では一致してしまい、取り違えに気づけない
      const row = await readRow(
        world,
        'SELECT name_kana, genre_id, area_id, description, postal_code, address, phone, website, budget_dinner_min, budget_dinner_max FROM shops WHERE id = ?',
        'shp_a_pub',
      );

      expect(row).toEqual({
        name_kana: 'エーノコウカイテン',
        genre_id: OTHER_GENRE_ID,
        area_id: OTHER_AREA_ID,
        description: '説明を入れた',
        postal_code: '160-0022',
        address: '東京都新宿区新宿3-1-1',
        phone: '03-1234-5678',
        website: 'https://example.com',
        budget_dinner_min: 3000,
        budget_dinner_max: 6000,
      });
    });

    it('経度だけの指定では経度も geohash も変えない', async () => {
      // 緯度側の条件だけを落とす変異は、undefined の緯度から geohash を
      // 計算しようとしてここで初めて表に出る
      const updated = await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_a_pub'),
        { longitude: OSAKA_LONGITUDE },
        new Date(100),
      );
      expect(updated?.lng).toBe(TEST_LONGITUDE);
      expect(updated?.geohash).toBe(SEEDED_GEOHASH);
    });

    it('null を明示した項目は null で上書きする', async () => {
      await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_a_pub'),
        { phone: '03-1234-5678' },
        new Date(100),
      );

      const updated = await updateShopAsOwner(
        db,
        ownerA,
        toShopId('shp_a_pub'),
        { phone: null },
        new Date(110),
      );

      expect(updated?.phone).toBeNull();
    });
  });

  describe('updateShopAsAdmin', () => {
    it('他人の店舗でも更新できる', async () => {
      const updated = await updateShopAsAdmin(
        db,
        admin,
        toShopId('shp_b_pub'),
        { name: '管理者改名' },
        new Date(100),
      );
      expect(updated?.name).toBe('管理者改名');
    });

    it('存在しない ID には null を返す', async () => {
      const updated = await updateShopAsAdmin(
        db,
        admin,
        toShopId('shp_nothing'),
        { name: 'x' },
        new Date(100),
      );
      expect(updated).toBeNull();
    });
  });

  describe('createShopAsAdmin', () => {
    it('指定した owner に紐づく店舗を作る', async () => {
      const created = await createShopAsAdmin(
        db,
        admin,
        NEW_SHOP_INPUT,
        toUserId(OWNER_A_ID),
        toShopId('shp_new'),
        new Date(300),
      );
      expect(created.id).toBe('shp_new');
      expect(created.ownerId).toBe(OWNER_A_ID);
      expect(created.name).toBe('新規店');
    });

    it('作成直後は draft', async () => {
      const created = await createShopAsAdmin(
        db,
        admin,
        NEW_SHOP_INPUT,
        toUserId(OWNER_A_ID),
        toShopId('shp_new'),
        new Date(300),
      );
      expect(created.status).toBe(SHOP_STATUS_DRAFT);
    });

    it('作成直後は draft なので user からは見えない', async () => {
      await createShopAsAdmin(
        db,
        admin,
        NEW_SHOP_INPUT,
        toUserId(OWNER_A_ID),
        toShopId('shp_new'),
        new Date(300),
      );
      expect(await findVisibleShop(db, user, toShopId('shp_new'))).toBeNull();
    });

    it('緯度経度から geohash を導出して保存する', async () => {
      const created = await createShopAsAdmin(
        db,
        admin,
        NEW_SHOP_INPUT,
        toUserId(OWNER_A_ID),
        toShopId('shp_new'),
        new Date(300),
      );
      expect(created.geohash).toBe(GINZA_GEOHASH);
      expect(created.lat).toBe(NEW_SHOP_INPUT.latitude);
      expect(created.lng).toBe(NEW_SHOP_INPUT.longitude);
    });

    it('createdAt と updatedAt に同じ値を入れる', async () => {
      const created = await createShopAsAdmin(
        db,
        admin,
        NEW_SHOP_INPUT,
        toUserId(OWNER_A_ID),
        toShopId('shp_new'),
        new Date(300),
      );
      expect(created.createdAt).toEqual(new Date(300));
      expect(created.updatedAt).toEqual(new Date(300));
    });
  });

  describe('deleteShopAsAdmin', () => {
    it('存在する店舗を削除して true を返す', async () => {
      expect(await deleteShopAsAdmin(db, admin, toShopId('shp_a_pub'))).toBe(true);
      expect(await findVisibleShop(db, admin, toShopId('shp_a_pub'))).toBeNull();
    });

    it('存在しない ID には false を返す', async () => {
      expect(await deleteShopAsAdmin(db, admin, toShopId('shp_nothing'))).toBe(false);
    });

    it('削除対象以外の行を消さない', async () => {
      await deleteShopAsAdmin(db, admin, toShopId('shp_a_pub'));
      const rows = await listVisibleShops(db, admin);
      expect(rows).toHaveLength(3);
    });
  });
});
