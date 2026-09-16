import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROFILE_STATUS_ACTIVE,
  PROFILE_STATUS_DELETED,
  PROFILE_STATUS_SUSPENDED,
  ROLE_ADMIN,
  ROLE_OWNER,
  ROLE_USER,
} from '../db/constants';
import { createDatabase } from '../db/client';
import { corruptProfileRole, createTestWorld, runWrite, seedUser } from '../test/fixtures';
import type { TestWorld } from '../test/fixtures';
import { decideActor, loadActor } from './load-actor';

describe('decideActor', () => {
  it('行が無ければ no-profile を返す', () => {
    expect(decideActor('usr_alice', undefined)).toEqual({ kind: 'no-profile' });
  });

  it('active な user から UserActor を作る', () => {
    const result = decideActor('usr_alice', { role: ROLE_USER, status: PROFILE_STATUS_ACTIVE });
    expect(result.kind).toBe('found');
    if (result.kind === 'found') {
      expect(result.actor.role).toBe(ROLE_USER);
      expect(result.actor.userId).toBe('usr_alice');
    }
  });

  it('active な owner から OwnerActor を作る', () => {
    const result = decideActor('usr_bob', { role: ROLE_OWNER, status: PROFILE_STATUS_ACTIVE });
    expect(result.kind).toBe('found');
    if (result.kind === 'found') {
      expect(result.actor.role).toBe(ROLE_OWNER);
    }
  });

  it('active な admin から AdminActor を作る', () => {
    const result = decideActor('usr_carol', { role: ROLE_ADMIN, status: PROFILE_STATUS_ACTIVE });
    expect(result.kind).toBe('found');
    if (result.kind === 'found') {
      expect(result.actor.role).toBe(ROLE_ADMIN);
    }
  });

  it('suspended なら suspended を返す', () => {
    expect(decideActor('usr_dave', { role: ROLE_USER, status: PROFILE_STATUS_SUSPENDED })).toEqual({
      kind: 'suspended',
    });
  });

  it('suspended な admin でも suspended を返す（特権を残さない）', () => {
    expect(decideActor('usr_eve', { role: ROLE_ADMIN, status: PROFILE_STATUS_SUSPENDED })).toEqual({
      kind: 'suspended',
    });
  });

  it('deleted（退会済み）も suspended と同じ扱いにする', () => {
    // status は active / suspended / deleted の 3 値。active 以外はすべて拒否する
    expect(decideActor('usr_frank', { role: ROLE_USER, status: PROFILE_STATUS_DELETED })).toEqual({
      kind: 'suspended',
    });
  });

  it('role が未知の値なら invalid-role を返す', () => {
    // DB 直編集やマイグレーション事故で壊れた値が入った場合に通してはいけない
    expect(decideActor('usr_grace', { role: 'superuser', status: PROFILE_STATUS_ACTIVE })).toEqual({
      kind: 'invalid-role',
    });
  });
});

describe('loadActor', () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    await world.dispose();
  });

  it('profiles が無いユーザーには no-profile を返す', async () => {
    const result = await loadActor(createDatabase(world.d1), 'usr_missing');
    expect(result).toEqual({ kind: 'no-profile' });
  });

  it('active な user から UserActor を作る', async () => {
    await seedUser(world, { userId: 'usr_alice', role: ROLE_USER });

    const result = await loadActor(createDatabase(world.d1), 'usr_alice');

    expect(result.kind).toBe('found');
    if (result.kind === 'found') {
      expect(result.actor.role).toBe(ROLE_USER);
      expect(result.actor.userId).toBe('usr_alice');
    }
  });

  it('suspended なユーザーには suspended を返す', async () => {
    await seedUser(world, {
      userId: 'usr_dave',
      role: ROLE_ADMIN,
      status: PROFILE_STATUS_SUSPENDED,
    });

    const result = await loadActor(createDatabase(world.d1), 'usr_dave');

    expect(result).toEqual({ kind: 'suspended' });
  });

  it('他のユーザーの profiles を混ぜて引かない', async () => {
    await seedUser(world, { userId: 'usr_alice', role: ROLE_ADMIN });
    await seedUser(world, { userId: 'usr_bob', role: ROLE_USER });

    const result = await loadActor(createDatabase(world.d1), 'usr_bob');

    expect(result.kind).toBe('found');
    if (result.kind === 'found') {
      // WHERE user_id が抜けていると先頭行（admin）が返ってしまう
      expect(result.actor.role).toBe(ROLE_USER);
    }
  });

  it('未知の role は DB の CHECK 制約が先に弾く（防御の一段目）', async () => {
    await seedUser(world, { userId: 'usr_grace', role: ROLE_USER });

    await expect(
      runWrite(world, 'UPDATE profiles SET role = ? WHERE user_id = ?', 'superuser', 'usr_grace'),
    ).rejects.toThrow(/CHECK constraint failed: ck_profiles_role/);
  });

  it('CHECK をすり抜けて壊れた role が入っていたら invalid-role を返す（防御の二段目）', async () => {
    await seedUser(world, { userId: 'usr_grace', role: ROLE_USER });
    await corruptProfileRole(world, 'usr_grace', 'superuser');

    const result = await loadActor(createDatabase(world.d1), 'usr_grace');

    expect(result).toEqual({ kind: 'invalid-role' });
  });
});
