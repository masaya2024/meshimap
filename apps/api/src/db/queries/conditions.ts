import type { SQL } from 'drizzle-orm';

/**
 * `and()` / `or()` の戻り値から undefined を外して `SQL` に絞る。
 *
 * Drizzle の `and()` / `or()` は `SQL | undefined` を返す。undefined になるのは
 * 引数が 0 個のときと、渡した条件がすべて undefined のときだけで、
 * 「条件なし」を可変長引数で表せるようにするための型である。
 * 条件を必ず 1 つ以上渡す呼び出しでは起こらないが、型の上には残るので毎回潰す必要がある。
 *
 * 呼び出し元ごとに `if (x === undefined) throw` を書くと、**実行されない分岐**が
 * そこら中に増える。実行されない以上どのテストも通らないので、
 * 中身が壊れても気づけないコードが増えていくということでもある
 * （実際ミューテーションテストで、この形の分岐だけが生き残った）。
 * ここへ集めておけば、この関数自体はテストから直接叩けるので分岐が検証対象になる。
 */
export function requireCondition(condition: SQL | undefined): SQL {
  if (condition === undefined) {
    throw new Error('SQL の条件を組み立てられませんでした');
  }

  return condition;
}
