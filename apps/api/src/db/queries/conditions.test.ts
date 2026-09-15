import { and, eq, gte } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { shops } from '../schema/shop';
import { requireCondition } from './conditions';

/**
 * 到達しない分岐をここへ集めた意味は「テストから直接叩けること」にある。
 * 条件を渡した場合と undefined を渡した場合の両方を必ず通しておくこと。
 */
describe('requireCondition', () => {
  it('条件をそのまま返す（包み直さない）', () => {
    const condition = eq(shops.id, 'shp_1');

    expect(requireCondition(condition)).toBe(condition);
  });

  it('条件が 2 つ以上でもそのまま返す', () => {
    const condition = and(eq(shops.status, 'published'), gte(shops.ratingAvg, 0));

    expect(requireCondition(condition)).toBe(condition);
  });

  it('undefined を渡すと理由付きで投げる', () => {
    expect(() => requireCondition(undefined)).toThrow('SQL の条件を組み立てられませんでした');
  });
});
