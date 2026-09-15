import { describe, expect, it } from 'vitest';
import {
  ROLES,
  ROLE_ADMIN,
  ROLE_OWNER,
  ROLE_USER,
  canManageShop,
  canModerate,
  isRole,
  toRole,
} from './role';

describe('ROLES', () => {
  it('利用者・店舗管理者・システム管理者の 3 種類を宣言順で持つ', () => {
    expect(ROLES).toEqual(['user', 'owner', 'admin']);
  });

  it('各ロール定数の値が設計書の文字列と一致する', () => {
    expect(ROLE_USER).toBe('user');
    expect(ROLE_OWNER).toBe('owner');
    expect(ROLE_ADMIN).toBe('admin');
  });

  it('重複したロールを含まない', () => {
    expect(new Set(ROLES).size).toBe(ROLES.length);
  });
});

describe('isRole', () => {
  it('定義済みのロール文字列を受け入れる', () => {
    expect(isRole('user')).toBe(true);
    expect(isRole('owner')).toBe(true);
    expect(isRole('admin')).toBe(true);
  });

  it('未知の文字列を拒否する', () => {
    expect(isRole('guest')).toBe(false);
  });

  it('空文字を拒否する', () => {
    expect(isRole('')).toBe(false);
  });

  it('大文字違いを拒否する', () => {
    expect(isRole('User')).toBe(false);
  });

  it('前後に空白がある値を拒否する', () => {
    expect(isRole(' user')).toBe(false);
  });

  it('文字列以外を拒否する', () => {
    expect(isRole(null)).toBe(false);
    expect(isRole(undefined)).toBe(false);
    expect(isRole(1)).toBe(false);
    expect(isRole({})).toBe(false);
    expect(isRole(['user'])).toBe(false);
  });
});

describe('toRole', () => {
  it('定義済みのロールをそのまま返す', () => {
    expect(toRole('owner')).toBe('owner');
  });

  it('未知の文字列を RangeError で拒否する', () => {
    expect(() => toRole('guest')).toThrow(new RangeError('未知のロールです: "guest"'));
  });

  it('null を RangeError で拒否する', () => {
    expect(() => toRole(null)).toThrow(new RangeError('未知のロールです: null'));
  });
});

describe('canManageShop', () => {
  it('店舗管理者とシステム管理者に許可する', () => {
    expect(canManageShop(ROLE_OWNER)).toBe(true);
    expect(canManageShop(ROLE_ADMIN)).toBe(true);
  });

  it('一般利用者には許可しない', () => {
    expect(canManageShop(ROLE_USER)).toBe(false);
  });
});

describe('canModerate', () => {
  it('システム管理者だけに許可する', () => {
    expect(canModerate(ROLE_ADMIN)).toBe(true);
  });

  it('店舗管理者と一般利用者には許可しない', () => {
    expect(canModerate(ROLE_OWNER)).toBe(false);
    expect(canModerate(ROLE_USER)).toBe(false);
  });
});
