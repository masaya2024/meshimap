import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, createLocalD1, type LocalD1 } from './local-d1';

describe('createLocalD1', () => {
  let local: LocalD1;

  beforeAll(async () => {
    local = await createLocalD1();
  });

  afterAll(async () => {
    await local.dispose();
  });

  it('miniflare 上で D1 が起動し、単純なクエリが実行できる', async () => {
    const result = await local.d1.prepare('SELECT 1 AS one').first<{ one: number }>();
    expect(result?.one).toBe(1);
  });

  it('applyMigrations は migrations/ の SQL を 1 文以上適用する', async () => {
    const executedStatementCount = await applyMigrations(local.d1);
    expect(executedStatementCount).toBeGreaterThan(0);
  });
});
