import { describe, expect, it } from 'vitest';
import * as coreConstants from '@meshimap/core';
import * as dbConstants from './constants';
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

/**
 * `@meshimap/core` と同じ名前で公開されている定数の数。
 *
 * 増減したらこの数を直す。ここを固定しておかないと、core 側の改名で
 * 重なりが減ったときに「比較する対象が消えた」ことに気づけず、
 * 下の比較が静かに素通りするようになる。
 */
const SHARED_CONSTANT_COUNT = 28;

/**
 * 名前で引けるようにした両者の公開値。
 *
 * module namespace を直接添字で引くと `keyof typeof` のキャストが要る。
 * `unknown` の辞書に展開してしまえばキャスト無しで引けて、値の比較に必要な
 * 情報は何も失われない（比較は toEqual が構造で行う）。
 */
const dbValues: Record<string, unknown> = { ...dbConstants };
const coreValues: Record<string, unknown> = { ...coreConstants };

/** 両方が公開している名前。core 側の型は値として現れないので自然に外れる */
const sharedNames = Object.keys(dbValues)
  .filter((name) => name in coreValues)
  .sort();

describe('@meshimap/core との二重定義', () => {
  /**
   * このファイルの冒頭が言うとおり、ここは Phase 4 で core からの再エクスポートに
   * 置き換わるまでの一時的な写しにすぎない。写しである間に値がずれると、
   * D1 側の CHECK 制約とアプリ側の判定が食い違い、しかも
   * **既存データがある状態では制約を張り直せない**ところまで進んでしまう。
   *
   * 型は別物（api 側は独自に宣言している）なので tsc では捕まらない。
   * ここで実行時に突き合わせるのが唯一の歯止め。
   */
  it('同じ名前の定数は core と同じ値である', () => {
    expect(sharedNames).toHaveLength(SHARED_CONSTANT_COUNT);

    // 名前をキーに持つオブジェクトどうしで比べる。値だけを比べると
    // 落ちたときにどの定数がずれたのか差分に出ない。
    const dbShared = Object.fromEntries(sharedNames.map((name) => [name, dbValues[name]]));
    const coreShared = Object.fromEntries(sharedNames.map((name) => [name, coreValues[name]]));

    expect(dbShared).toEqual(coreShared);
  });
});
