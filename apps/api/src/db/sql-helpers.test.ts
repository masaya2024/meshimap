import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import {
  atLeast,
  atMostColumn,
  betweenInclusive,
  consistsOf,
  inValues,
  isBooleanInteger,
  lengthAtMost,
  lengthIs,
  matchesGlob,
} from './sql-helpers';
import { sql } from 'drizzle-orm';

const dialect = new SQLiteSyncDialect();

describe('inValues', () => {
  it('許可リストをシングルクォート付きのリテラルとして展開する', () => {
    const query = dialect.sqlToQuery(inValues(sql`role`, ['user', 'owner', 'admin']));
    expect(query.sql).toBe("role IN ('user', 'owner', 'admin')");
  });

  it('バインドパラメータを 1 つも作らない（CHECK 制約では ? が使えないため）', () => {
    const query = dialect.sqlToQuery(inValues(sql`role`, ['user', 'owner', 'admin']));
    expect(query.params).toEqual([]);
  });

  it('値にシングルクォートが含まれても SQL を壊さない', () => {
    const query = dialect.sqlToQuery(inValues(sql`name`, ["o'brien"]));
    expect(query.sql).toBe("name IN ('o''brien')");
  });
});

describe('betweenInclusive', () => {
  it('数値をリテラルとして展開する', () => {
    const query = dialect.sqlToQuery(betweenInclusive(sql`rating`, 1, 5));
    expect(query.sql).toBe('rating BETWEEN 1 AND 5');
    expect(query.params).toEqual([]);
  });

  it('境界が同じ値でも成立する（1 点だけ許す制約を書けること）', () => {
    const query = dialect.sqlToQuery(betweenInclusive(sql`n`, 7, 7));
    expect(query.sql).toBe('n BETWEEN 7 AND 7');
  });

  it('NaN を渡したら例外を投げる（壊れた DDL を生成させない）', () => {
    expect(() => betweenInclusive(sql`n`, Number.NaN, 5)).toThrow(/埋め込めない数値/);
  });

  it('Infinity を渡したら例外を投げる', () => {
    expect(() => betweenInclusive(sql`n`, 0, Number.POSITIVE_INFINITY)).toThrow(/埋め込めない数値/);
  });
});

describe('lengthAtMost', () => {
  it('length() による上限比較を組み立てる', () => {
    const query = dialect.sqlToQuery(lengthAtMost(sql`body`, 2000));
    expect(query.sql).toBe('length(body) <= 2000');
    expect(query.params).toEqual([]);
  });
});

describe('atLeast', () => {
  it('下限比較を組み立てる', () => {
    const query = dialect.sqlToQuery(atLeast(sql`view_count`, 0));
    expect(query.sql).toBe('view_count >= 0');
    expect(query.params).toEqual([]);
  });
});

describe('lengthIs', () => {
  it('文字数の完全一致を組み立てる', () => {
    const query = dialect.sqlToQuery(lengthIs(sql`geohash`, 7));
    expect(query.sql).toBe('length(geohash) = 7');
    expect(query.params).toEqual([]);
  });
});

describe('atMostColumn', () => {
  it('列どうしの大小関係を組み立てる（予算の min <= max など）', () => {
    const query = dialect.sqlToQuery(atMostColumn(sql`budget_min`, sql`budget_max`));
    expect(query.sql).toBe('budget_min <= budget_max');
    expect(query.params).toEqual([]);
  });
});

describe('isBooleanInteger', () => {
  it('真偽値の列を 0 と 1 だけに縛る', () => {
    const query = dialect.sqlToQuery(isBooleanInteger(sql`is_cover`));
    expect(query.sql).toBe('is_cover IN (0, 1)');
    expect(query.params).toEqual([]);
  });
});

describe('matchesGlob', () => {
  it('GLOB パターンをリテラルとして展開する', () => {
    const query = dialect.sqlToQuery(
      matchesGlob(sql`date`, '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    );
    expect(query.sql).toBe("date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'");
    expect(query.params).toEqual([]);
  });
});

describe('consistsOf', () => {
  it('「許可文字だけからなる非空文字列」を否定形の GLOB で表す', () => {
    const query = dialect.sqlToQuery(consistsOf(sql`slug`, 'a-z0-9-'));
    // GLOB '[a-z0-9-]*' は先頭 1 文字しか見ないため誤り。否定形で「許可外の文字を 1 つも含まない」と書く
    expect(query.sql).toBe("slug <> '' AND slug NOT GLOB '*[^a-z0-9-]*'");
    expect(query.params).toEqual([]);
  });
});
