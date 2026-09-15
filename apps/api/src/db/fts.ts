/**
 * `shops_fts`（FTS5 仮想テーブル）に投げる検索式を組み立てる。
 *
 * 仮想テーブルと同期トリガーの定義は `migrations/0001_shops_fts.sql` にある。
 * Drizzle は仮想テーブルを表現できないため、スキーマ定義ではなく手書き SQL 側が正。
 */
import { FTS_TRIGRAM_MIN_LENGTH } from './constants';

/** FTS5 仮想テーブルの名前。生 SQL に文字列を散らかさないための定数 */
export const SHOPS_FTS_TABLE_NAME = 'shops_fts';

/**
 * 語の取り出し方。**区切りではなく語そのものを拾う。**
 *
 * `split(/\s+/u)` でも結果は同じになるが、そちらは採らない。
 * 割り方だと連続した空白が空文字列のトークンを生み、それを下流の
 * `length >= FTS_TRIGRAM_MIN_LENGTH` が捨てる、という形になる。
 * 捨てる側があるせいで `\s+` の `+` を落としても出力が 1 文字も変わらず、
 * **区切りの定義が壊れてもどんなテストでも気づけない**（ミューテーションテストで実測）。
 * 拾い方なら空のトークンがそもそも生まれないので、この式の間違いは必ず出力に出る。
 *
 * JavaScript の `\S` は全角スペース（U+3000）を空白として扱うので、全角区切りも拾える。
 * 正規表現リテラルへ不可視の U+3000 を直接書くと読めなくなるため、`\S` に寄せている。
 *
 * `g` 付きの正規表現は `exec` / `test` だと `lastIndex` を持ち越すが、
 * `String.prototype.match` は呼ぶたびに 0 へ戻すので使い回してよい。
 */
const TOKEN_PATTERN = /\S+/gu;

/** 複数語をつなぐ FTS5 の演算子。1 語でも欠けたらヒットさせない（絞り込み優先） */
const TOKEN_JOIN_OPERATOR = ' AND ';

/**
 * 検索語 1 つを FTS5 の式に埋め込める形にする。
 *
 * 二重引用符で包むと、中身は `OR` `NEAR` `*` `(` `-` を含めてすべてただの語句になる。
 * 包まないと `道玄坂1-2-3` が `no such column: 2`、`(` が `fts5: syntax error` を投げる。
 * 語の中の `"` は FTS5 の規則に従い 2 つ重ねて打ち消す。
 */
export function escapeFtsToken(token: string): string {
  return `"${token.replaceAll('"', '""')}"`;
}

/**
 * ユーザーの入力欄の文字列から `MATCH` に渡す式を作る。
 *
 * 空白で区切って AND でつなぐ。trigram では 3 文字未満がヒットしないので落とす。
 * 使える語が 1 つも残らなければ `null` を返す。
 * 呼び出し側は `null` を見て LIKE 検索へフォールバックすること（Phase 6）。
 */
export function buildFtsMatchQuery(rawInput: string): string | null {
  const usableTokens = (rawInput.match(TOKEN_PATTERN) ?? [])
    .filter((token) => token.length >= FTS_TRIGRAM_MIN_LENGTH)
    .map((token) => escapeFtsToken(token));

  if (usableTokens.length === 0) {
    return null;
  }

  return usableTokens.join(TOKEN_JOIN_OPERATOR);
}
