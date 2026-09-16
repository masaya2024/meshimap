import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '@meshimap/core';
import { describe, expect, it } from 'vitest';
import { PROFILE_DISPLAY_NAME_MAX_LENGTH } from '../lib/constants';
import * as db from './constants';

/**
 * マイグレーション本文。CHECK 制約に焼かれた数値と TypeScript 側の定数を突き合わせる。
 *
 * `readFileSync(new URL(...))` と書けないのは、この tsconfig のグローバル `URL` が
 * `@cloudflare/workers-types` のもので、Node の `fs` が要求する `node:url` の `URL` と
 * 別物として扱われるため（TS2769 を実測）。src/db/testing/local-d1.ts と同じく
 * パス文字列へ落としてから読む。
 */
const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(CURRENT_DIR, '..', '..', 'migrations', '0000_init.sql'),
  'utf8',
);

/**
 * 両方に同じ名前で存在する数値定数。
 * 名前空間 import を配列に展開して比較する。文字列キーで引くと
 * 型チェックが効かず「片方にしか無い名前」を書いても通ってしまうため、
 * 明示的に両辺を書き並べる。
 */
const SHARED_NUMBERS: ReadonlyArray<readonly [name: string, fromCore: number, fromDb: number]> = [
  ['RATING_MIN', core.RATING_MIN, db.RATING_MIN],
  ['RATING_MAX', core.RATING_MAX, db.RATING_MAX],
  ['BUDGET_YEN_MIN', core.BUDGET_YEN_MIN, db.BUDGET_YEN_MIN],
  ['BUDGET_YEN_MAX', core.BUDGET_YEN_MAX, db.BUDGET_YEN_MAX],
  ['DAY_OF_WEEK_MIN', core.DAY_OF_WEEK_MIN, db.DAY_OF_WEEK_MIN],
  ['DAY_OF_WEEK_MAX', core.DAY_OF_WEEK_MAX, db.DAY_OF_WEEK_MAX],
  ['MINUTE_OF_DAY_MIN', core.MINUTE_OF_DAY_MIN, db.MINUTE_OF_DAY_MIN],
  ['MINUTE_OF_DAY_MAX', core.MINUTE_OF_DAY_MAX, db.MINUTE_OF_DAY_MAX],
  ['MINUTES_PER_DAY', core.MINUTES_PER_DAY, db.MINUTES_PER_DAY],
  ['PARTY_SIZE_MIN', core.PARTY_SIZE_MIN, db.PARTY_SIZE_MIN],
  ['PARTY_SIZE_MAX', core.PARTY_SIZE_MAX, db.PARTY_SIZE_MAX],
  ['SLOT_MINUTES_MIN', core.SLOT_MINUTES_MIN, db.SLOT_MINUTES_MIN],
  ['SLOT_MINUTES_MAX', core.SLOT_MINUTES_MAX, db.SLOT_MINUTES_MAX],
  ['SEAT_CAPACITY_MIN', core.SEAT_CAPACITY_MIN, db.SEAT_CAPACITY_MIN],
  ['SEAT_CAPACITY_MAX', core.SEAT_CAPACITY_MAX, db.SEAT_CAPACITY_MAX],
  ['MAX_PARALLEL_MIN', core.MAX_PARALLEL_MIN, db.MAX_PARALLEL_MIN],
  ['MAX_PARALLEL_MAX', core.MAX_PARALLEL_MAX, db.MAX_PARALLEL_MAX],
  ['SHOP_NAME_MAX_LENGTH', core.SHOP_NAME_MAX_LENGTH, db.SHOP_NAME_MAX_LENGTH],
  ['SHOP_NAME_KANA_MAX_LENGTH', core.SHOP_NAME_KANA_MAX_LENGTH, db.SHOP_NAME_KANA_MAX_LENGTH],
  ['SHOP_ADDRESS_MAX_LENGTH', core.SHOP_ADDRESS_MAX_LENGTH, db.SHOP_ADDRESS_MAX_LENGTH],
  ['SHOP_DESCRIPTION_MAX_LENGTH', core.SHOP_DESCRIPTION_MAX_LENGTH, db.SHOP_DESCRIPTION_MAX_LENGTH],
  ['REVIEW_BODY_MAX_LENGTH', core.REVIEW_BODY_MAX_LENGTH, db.REVIEW_BODY_MAX_LENGTH],
  ['RESERVATION_NOTE_MAX_LENGTH', core.RESERVATION_NOTE_MAX_LENGTH, db.RESERVATION_NOTE_MAX_LENGTH],
  ['IDENTIFIER_MAX_LENGTH', core.IDENTIFIER_MAX_LENGTH, db.IDENTIFIER_MAX_LENGTH],
];

describe('@meshimap/core と src/db/constants.ts の値の一致', () => {
  it.each(SHARED_NUMBERS)('%s が両者で一致する', (_name, fromCore, fromDb) => {
    expect(fromDb).toBe(fromCore);
  });

  it('ロールの値が一致する', () => {
    expect(db.ROLE_USER).toBe(core.ROLE_USER);
    expect(db.ROLE_OWNER).toBe(core.ROLE_OWNER);
    expect(db.ROLE_ADMIN).toBe(core.ROLE_ADMIN);
  });

  it('ロールの並びと個数が一致する', () => {
    // profiles.role の CHECK 制約はこの並びで生成されている。
    // 増減すると「core には存在するが DB が受け付けない」ロールが生まれる。
    expect([...db.ROLES]).toStrictEqual([...core.ROLES]);
  });

  it('ck_profiles_display_name_length が PROFILE_DISPLAY_NAME_MAX_LENGTH と一致する', () => {
    // src/db/schema/master.ts の DISPLAY_NAME_MAX_LENGTH は export されていないので
    // 生成物（マイグレーション本文）を正として突き合わせる
    expect(migrationSql).toContain(
      `CHECK(length("profiles"."display_name") <= ${PROFILE_DISPLAY_NAME_MAX_LENGTH})`,
    );
  });

  it('ck_shops_geohash_length が SHOP_GEOHASH_PRECISION と一致する', () => {
    expect(migrationSql).toContain(
      `CHECK(length("shops"."geohash") = ${db.SHOP_GEOHASH_PRECISION})`,
    );
  });

  it('ck_profiles_role の列挙が ROLES と一致する', () => {
    const roleList = db.ROLES.map((role) => `'${role}'`).join(', ');
    expect(migrationSql).toContain(`CHECK("profiles"."role" IN (${roleList}))`);
  });

  it('core にロール以外の状態値が無いことを確認する', () => {
    // 状態値（SHOP_STATUS_* など）の定義元は db/constants.ts 側だけ、という前提を固定する。
    // core に生えたらこのテストが落ちるので、そのとき定義元を一本化する判断をする。
    const coreNames = Object.keys(core);
    expect(coreNames.filter((name) => name.endsWith('_STATUS_ACTIVE'))).toStrictEqual([]);
    expect(coreNames.filter((name) => name.startsWith('SHOP_STATUS_'))).toStrictEqual([]);
    expect(coreNames.filter((name) => name.startsWith('REVIEW_STATUS_'))).toStrictEqual([]);
  });
});
