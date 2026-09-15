import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * CHECK 制約の式を組み立てるヘルパ。
 *
 * なぜ必要か:
 * Drizzle の `` sql`${値}` `` は値をバインドパラメータにするが、CHECK 制約は DDL の一部であり
 * パラメータを使えない。そのまま書くと `CHECK(role IN (?, ?, ?))` という壊れた SQL が生成される。
 * ここでは `sql.raw()` で値をリテラルとして埋め込む。
 *
 * 埋め込む値は必ず `constants.ts` の定数（開発者が書いた固定値）であり、
 * ユーザー入力は 1 つも通らない。それでも取り違えに備えてクォートのエスケープと
 * 数値の有限性チェックを入れてある。
 */

/** SQL の文字列リテラルへ変換する。シングルクォートは SQL の規則どおり 2 個重ねて逃がす */
function toSqlStringLiteral(value: string): SQL {
  return sql.raw(`'${value.replaceAll("'", "''")}'`);
}

/** SQL の数値リテラルへ変換する。NaN / Infinity は DDL として無意味なので早期に落とす */
function toSqlNumberLiteral(value: number): SQL {
  if (!Number.isFinite(value)) {
    throw new Error(`CHECK 制約に埋め込めない数値です: ${String(value)}`);
  }
  return sql.raw(String(value));
}

/** SQLite における真偽値の表現。`mode: 'boolean'` の列はこの 2 値しか取らない */
const BOOLEAN_FALSE_INTEGER = 0;
const BOOLEAN_TRUE_INTEGER = 1;

/** `column IN ('a', 'b', 'c')` — 列挙値を DB レベルで縛る */
export function inValues(column: SQLWrapper, allowedValues: readonly string[]): SQL {
  const literals = allowedValues.map((value) => toSqlStringLiteral(value));
  return sql`${column} IN (${sql.join(literals, sql`, `)})`;
}

/** `column BETWEEN min AND max` — 上下限を両端込みで縛る */
export function betweenInclusive(column: SQLWrapper, minValue: number, maxValue: number): SQL {
  return sql`${column} BETWEEN ${toSqlNumberLiteral(minValue)} AND ${toSqlNumberLiteral(maxValue)}`;
}

/** `length(column) <= max` — 文字列長の上限。SQLite の length() は文字数を返す */
export function lengthAtMost(column: SQLWrapper, maxLength: number): SQL {
  return sql`length(${column}) <= ${toSqlNumberLiteral(maxLength)}`;
}

/** `length(column) = n` — 文字数が固定の列（geohash の precision など） */
export function lengthIs(column: SQLWrapper, exactLength: number): SQL {
  return sql`length(${column}) = ${toSqlNumberLiteral(exactLength)}`;
}

/** `column >= min` — カウンタなどの下限 */
export function atLeast(column: SQLWrapper, minValue: number): SQL {
  return sql`${column} >= ${toSqlNumberLiteral(minValue)}`;
}

/**
 * `left <= right` — 列どうしの大小関係。予算の min <= max などに使う。
 * どちらかが NULL なら式全体が NULL になり、CHECK は通る（片側だけ指定された予算を許すため都合がよい）。
 */
export function atMostColumn(left: SQLWrapper, right: SQLWrapper): SQL {
  return sql`${left} <= ${right}`;
}

/**
 * `column IN (0, 1)` — 真偽値の列。
 *
 * SQLite に BOOLEAN 型はなく、Drizzle の `mode: 'boolean'` も実体は INTEGER でしかない。
 * シードやマイグレーションの生 SQL から `2` や `-1` を書き込めてしまうため DB 側で縛る。
 */
export function isBooleanInteger(column: SQLWrapper): SQL {
  return sql`${column} IN (${toSqlNumberLiteral(BOOLEAN_FALSE_INTEGER)}, ${toSqlNumberLiteral(BOOLEAN_TRUE_INTEGER)})`;
}

/** `column GLOB 'pattern'` — 書式を GLOB で縛る。日付の `YYYY-MM-DD` など */
export function matchesGlob(column: SQLWrapper, pattern: string): SQL {
  return sql`${column} GLOB ${toSqlStringLiteral(pattern)}`;
}

/**
 * 「許可された文字だけからなる非空文字列」に縛る。
 *
 * `` col GLOB '[a-z0-9-]*' `` と書きたくなるが、GLOB の `[...]` は **1 文字**にしか対応せず
 * 続く `*` が残り全部を無条件に飲み込むため、`'ra men'` のような値が通ってしまう。
 * 「許可外の文字を 1 つでも含む」の否定で書くのが正しい。
 * さらに GLOB は空文字にマッチしないため、`<> ''` を明示的に AND する。
 */
export function consistsOf(column: SQLWrapper, allowedCharacterClass: string): SQL {
  const forbiddenPattern = `*[^${allowedCharacterClass}]*`;
  return sql`${column} <> '' AND ${column} NOT GLOB ${toSqlStringLiteral(forbiddenPattern)}`;
}
