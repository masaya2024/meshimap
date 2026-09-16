import { ROLE_ADMIN, ROLE_OWNER, ROLE_USER } from '@meshimap/core';
import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_VIEWER,
  ROLE_ANONYMOUS,
  isAdminActor,
  isAuthenticatedActor,
  isOwnerActor,
  isUserActor,
  toActor,
} from './actor';

describe('toActor', () => {
  it('user ロールから UserActor を作る', () => {
    const actor = toActor('usr_alice', ROLE_USER);
    expect(actor.role).toBe(ROLE_USER);
    expect(actor.userId).toBe('usr_alice');
  });

  it('owner ロールから OwnerActor を作る', () => {
    const actor = toActor('usr_bob', ROLE_OWNER);
    expect(actor.role).toBe(ROLE_OWNER);
    expect(actor.userId).toBe('usr_bob');
  });

  it('admin ロールから AdminActor を作る', () => {
    const actor = toActor('usr_carol', ROLE_ADMIN);
    expect(actor.role).toBe(ROLE_ADMIN);
    expect(actor.userId).toBe('usr_carol');
  });

  it('識別子として不正な userId を拒否する', () => {
    // toUserId（@meshimap/core）の検証をそのまま通すので、空文字や記号は弾かれる
    expect(() => toActor('', ROLE_USER)).toThrow(RangeError);
  });

  it('生成された Actor は凍結されていて後から書き換えられない', () => {
    const actor = toActor('usr_alice', ROLE_USER);
    expect(Object.isFrozen(actor)).toBe(true);
  });
});

describe('ANONYMOUS_VIEWER', () => {
  it('role は anonymous で userId は null である', () => {
    expect(ANONYMOUS_VIEWER.role).toBe(ROLE_ANONYMOUS);
    expect(ANONYMOUS_VIEWER.userId).toBeNull();
  });

  it('凍結されていて書き換えられない', () => {
    expect(Object.isFrozen(ANONYMOUS_VIEWER)).toBe(true);
  });
});

describe('型ガード', () => {
  const userActor = toActor('usr_alice', ROLE_USER);
  const ownerActor = toActor('usr_bob', ROLE_OWNER);
  const adminActor = toActor('usr_carol', ROLE_ADMIN);

  it('isUserActor は UserActor にだけ true を返す', () => {
    expect(isUserActor(userActor)).toBe(true);
    expect(isUserActor(ownerActor)).toBe(false);
    expect(isUserActor(adminActor)).toBe(false);
    expect(isUserActor(ANONYMOUS_VIEWER)).toBe(false);
  });

  it('isOwnerActor は OwnerActor にだけ true を返す', () => {
    expect(isOwnerActor(ownerActor)).toBe(true);
    expect(isOwnerActor(userActor)).toBe(false);
    expect(isOwnerActor(adminActor)).toBe(false);
    expect(isOwnerActor(ANONYMOUS_VIEWER)).toBe(false);
  });

  it('isAdminActor は AdminActor にだけ true を返す', () => {
    expect(isAdminActor(adminActor)).toBe(true);
    expect(isAdminActor(userActor)).toBe(false);
    expect(isAdminActor(ownerActor)).toBe(false);
    expect(isAdminActor(ANONYMOUS_VIEWER)).toBe(false);
  });

  it('isAuthenticatedActor は匿名にだけ false を返す', () => {
    expect(isAuthenticatedActor(userActor)).toBe(true);
    expect(isAuthenticatedActor(ownerActor)).toBe(true);
    expect(isAuthenticatedActor(adminActor)).toBe(true);
    expect(isAuthenticatedActor(ANONYMOUS_VIEWER)).toBe(false);
  });
});
