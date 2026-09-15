import { describe, expect, it } from 'vitest';
import {
  APPLICATION_STATUSES,
  ISO_DATE_GLOB_PATTERN,
  NOTIFICATION_TYPES,
  PROFILE_STATUSES,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  RESERVATION_STATUSES,
  REVIEW_STATUSES,
  ROLES,
  SHOP_STATUSES,
} from './constants';

describe('列挙値', () => {
  it('ROLES は設計書 §4 の 3 ロールと完全一致する', () => {
    expect(ROLES).toEqual(['user', 'owner', 'admin']);
  });

  it('PROFILE_STATUSES は active / suspended / deleted の 3 種', () => {
    expect(PROFILE_STATUSES).toEqual(['active', 'suspended', 'deleted']);
  });

  it('SHOP_STATUSES は下書きから閉店までの 5 種', () => {
    expect(SHOP_STATUSES).toEqual(['draft', 'pending', 'published', 'suspended', 'closed']);
  });

  it('RESERVATION_STATUSES は承認フローと来店結果を表す 6 種', () => {
    expect(RESERVATION_STATUSES).toEqual([
      'pending',
      'confirmed',
      'rejected',
      'cancelled',
      'completed',
      'no_show',
    ]);
  });

  it('REVIEW_STATUSES は published / hidden / deleted の 3 種', () => {
    expect(REVIEW_STATUSES).toEqual(['published', 'hidden', 'deleted']);
  });

  it('REPORT_STATUSES は通報キューの 4 状態', () => {
    expect(REPORT_STATUSES).toEqual(['open', 'in_review', 'resolved', 'rejected']);
  });

  it('REPORT_TARGET_TYPES は設計書 5.1 の通報対象 3 種', () => {
    expect(REPORT_TARGET_TYPES).toEqual(['shop', 'review', 'user']);
  });

  it('APPLICATION_STATUSES は差し戻し（returned）を含む 4 種', () => {
    expect(APPLICATION_STATUSES).toEqual(['pending', 'approved', 'rejected', 'returned']);
  });

  it('NOTIFICATION_TYPES に重複がない', () => {
    expect(new Set(NOTIFICATION_TYPES).size).toBe(NOTIFICATION_TYPES.length);
  });
});

describe('列挙値の形式', () => {
  const ALL_ENUMS = [
    ROLES,
    PROFILE_STATUSES,
    SHOP_STATUSES,
    RESERVATION_STATUSES,
    REVIEW_STATUSES,
    REPORT_STATUSES,
    REPORT_TARGET_TYPES,
    APPLICATION_STATUSES,
    NOTIFICATION_TYPES,
  ];

  it('すべて小文字スネークケースである（SQL に直に入るため表記ゆれを禁止する）', () => {
    for (const values of ALL_ENUMS) {
      for (const value of values) {
        expect(value).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  it('どの列挙も空でなく、要素が重複していない', () => {
    for (const values of ALL_ENUMS) {
      expect(values.length).toBeGreaterThan(0);
      expect(new Set(values).size).toBe(values.length);
    }
  });
});

describe('GLOB パターン', () => {
  it('ISO_DATE_GLOB_PATTERN は 4-2-2 桁の数字を並べた形になっている', () => {
    // SQLite の GLOB に桁数指定（\d{4}）はないため、[0-9] を桁数ぶん並べるしかない。
    // 数え間違いがあっても見た目では気づけないので、期待値を直接書いて固定する。
    expect(ISO_DATE_GLOB_PATTERN).toBe('[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
  });
});
