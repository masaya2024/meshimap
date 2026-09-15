import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema';

/**
 * このアプリの Drizzle クライアント型。
 * `schema` を型引数に渡してあるので `database.query.shops.findMany()` のような
 * リレーショナルクエリも型付きで使える。
 */
export type Database = DrizzleD1Database<typeof schema>;

/**
 * D1 バインディングから Drizzle クライアントを作る。
 *
 * `Env` を受け取らないのは意図的。Phase 4 でバインディングが増えても
 * この層の型が動かないようにしている。呼び出し側が `env.DB` を渡す。
 */
export function createDatabase(d1: D1Database): Database {
  return drizzle(d1, { schema });
}
