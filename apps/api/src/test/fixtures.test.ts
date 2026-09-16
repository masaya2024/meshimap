import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROFILE_STATUS_SUSPENDED,
  ROLE_OWNER,
  ROLE_USER,
  SHOP_STATUS_DRAFT,
} from '../db/constants';
import {
  countRows,
  createTestWorld,
  readRow,
  runWrite,
  seedMasters,
  seedShop,
  seedUser,
  TEST_AREA_ID,
  TEST_GENRE_ID,
} from './fixtures';
import type { TestWorld } from './fixtures';

describe('createTestWorld', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('migrations/ を適用済みの D1 を返す', async () => {
    const row = await readRow(
      world,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      'shops',
    );

    expect(row).toEqual({ name: 'shops' });
  });

  it('呼ぶたびに独立した D1 を返す（テスト間で状態が漏れない）', async () => {
    // 同じ世界を使い回すと、実行順でテスト結果が変わる。ここが緑であることが
    // 権限マトリクス（Task 4-12）の前提になる
    const other = await createTestWorld();
    await seedMasters(world);

    const seenFromOther = await countRows(other, 'SELECT COUNT(*) AS count FROM genres');
    const seenFromWorld = await countRows(world, 'SELECT COUNT(*) AS count FROM genres');

    await other.dispose();
    expect(seenFromOther).toBe(0);
    expect(seenFromWorld).toBe(1);
  });
});

describe('readRow / countRows / runWrite', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('readRow は 0 件のとき null を返す', async () => {
    const row = await readRow(world, 'SELECT id FROM user WHERE id = ?', 'usr_missing');
    expect(row).toBeNull();
  });

  it('countRows は 0 件のとき 0 を返す', async () => {
    const count = await countRows(world, 'SELECT COUNT(*) AS count FROM user');
    expect(count).toBe(0);
  });

  it('runWrite は更新した行数を返す', async () => {
    await seedUser(world, { userId: 'usr_alice', role: ROLE_USER });

    const changed = await runWrite(
      world,
      'UPDATE user SET name = ? WHERE id = ?',
      'A',
      'usr_alice',
    );

    expect(changed).toBe(1);
  });

  it('runWrite は 1 行も一致しなければ 0 を返す', async () => {
    const changed = await runWrite(world, 'UPDATE user SET name = ? WHERE id = ?', 'A', 'usr_zzz');
    expect(changed).toBe(0);
  });
});

describe('seedUser', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('user と profiles を 1 行ずつ作る', async () => {
    await seedUser(world, { userId: 'usr_bob', role: ROLE_OWNER });

    const userRow = await readRow(world, 'SELECT id, email FROM user WHERE id = ?', 'usr_bob');
    const profileRow = await readRow(
      world,
      'SELECT role, status FROM profiles WHERE user_id = ?',
      'usr_bob',
    );

    expect(userRow).toEqual({ id: 'usr_bob', email: 'usr_bob@example.test' });
    expect(profileRow).toEqual({ role: 'owner', status: 'active' });
  });

  it('status を指定すると profiles にそのまま入る', async () => {
    await seedUser(world, {
      userId: 'usr_carol',
      role: ROLE_USER,
      status: PROFILE_STATUS_SUSPENDED,
    });

    const profileRow = await readRow(
      world,
      'SELECT status FROM profiles WHERE user_id = ?',
      'usr_carol',
    );

    expect(profileRow).toEqual({ status: 'suspended' });
  });
});

describe('seedShop', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('seedMasters と seedUser の後なら店舗を作れる', async () => {
    await seedMasters(world);
    await seedUser(world, { userId: 'usr_bob', role: ROLE_OWNER });

    await seedShop(world, { id: 'shp_1', ownerId: 'usr_bob', name: 'B 店' });

    const row = await readRow(
      world,
      'SELECT owner_id, name, status, genre_id, area_id FROM shops WHERE id = ?',
      'shp_1',
    );

    expect(row).toEqual({
      owner_id: 'usr_bob',
      name: 'B 店',
      status: 'published',
      genre_id: TEST_GENRE_ID,
      area_id: TEST_AREA_ID,
    });
  });

  it('status を指定すると shops にそのまま入る', async () => {
    await seedMasters(world);
    await seedUser(world, { userId: 'usr_bob', role: ROLE_OWNER });

    await seedShop(world, { id: 'shp_2', ownerId: 'usr_bob', status: SHOP_STATUS_DRAFT });

    const row = await readRow(world, 'SELECT status FROM shops WHERE id = ?', 'shp_2');
    expect(row).toEqual({ status: 'draft' });
  });

  it('マスタを入れずに店舗を作ると外部キー制約で落ちる（本物の制約が効いている証拠）', async () => {
    await seedUser(world, { userId: 'usr_bob', role: ROLE_OWNER });

    await expect(seedShop(world, { id: 'shp_3', ownerId: 'usr_bob' })).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it('存在しない owner_id を指定すると外部キー制約で落ちる', async () => {
    await seedMasters(world);

    await expect(seedShop(world, { id: 'shp_4', ownerId: 'usr_missing' })).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it('owner_id に null を入れられる（shops.owner_id は NULL 可）', async () => {
    await seedMasters(world);

    await seedShop(world, { id: 'shp_5', ownerId: null });

    const row = await readRow(world, 'SELECT owner_id FROM shops WHERE id = ?', 'shp_5');
    expect(row).toEqual({ owner_id: null });
  });
});
