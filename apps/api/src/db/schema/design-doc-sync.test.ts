/**
 * 設計書 §6「データモデル」の列挙と、`index.ts` が再エクスポートしているテーブルの同期を検証する。
 *
 * 設計書に書かずにテーブルを足した場合も、逆に設計書だけ直してスキーマを忘れた場合もここで落ちる。
 *
 * このファイルだけ Stryker から除外している（`stryker.config.mjs`）。読みに行く設計書は
 * リポジトリルートの docs/ にあるが、Stryker のサンドボックスは apps/api 配下しかコピーしないため、
 * サンドボックスでは必ず ENOENT で落ちるから。
 * 逆に言えば、サンドボックス外を読むテストはこのファイルだけに閉じ込めること。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableName, isTable } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from './index';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

/** src/db/schema/ からリポジトリルートの設計書まで */
const DESIGN_DOC_PATH = join(
  CURRENT_DIR,
  '..',
  '..',
  '..',
  '..',
  '..',
  'docs',
  'superpowers',
  'specs',
  '2026-09-15-meshimap-design.md',
);

/** 設計書 §6 のコードブロックで、テーブル名とカラム列挙を隔てている空白 */
const DESIGN_DOC_TABLE_PATTERN = /^([a-z_]+) {2,}/gm;

/**
 * 設計書 §6 のコードブロックに列挙されているテーブル名を読み出す。
 *
 * index.test.ts の期待値配列を「テストが勝手に決めた期待値」で終わらせないための仕掛け。
 * 継続行は字下げされていて行頭に一致せず、`-- 認証` のようなコメント行も一致しない。
 */
function readDesignDocTableNames(): readonly string[] {
  const designDoc = readFileSync(DESIGN_DOC_PATH, 'utf8');
  const section = designDoc.slice(
    designDoc.indexOf('## 6. データモデル'),
    designDoc.indexOf('## 7. ディレクトリ構成'),
  );
  const codeBlock = section.slice(section.indexOf('```') + 3, section.lastIndexOf('```'));

  return [...codeBlock.matchAll(DESIGN_DOC_TABLE_PATTERN)].map((match) => match[1] ?? '');
}

/**
 * index.ts が再エクスポートしているテーブル名。
 *
 * index.test.ts に同じ導出があるが共有していない。テストファイル同士を import すると
 * 相手の describe まで取り込んで二重に実行してしまい、除外したはずのこのファイルが
 * index.test.ts 経由で Stryker のサンドボックスに紛れ込むため。
 */
function collectExportedTableNames(): readonly string[] {
  return Object.values(schema)
    .filter((exported) => isTable(exported))
    .map((table) => getTableName(table))
    .sort();
}

describe('設計書 §6 とスキーマの同期', () => {
  it('設計書 §6 の列挙と再エクスポートしているテーブルがそろっている', () => {
    // 並び順は比較しない。設計書は関連の近いテーブルを並べ、こちらはスキーマの
    // ファイル単位で並べていて、軸が違うだけの差を落とす意味がないため。
    expect([...readDesignDocTableNames()].sort()).toEqual(collectExportedTableNames());
  });
});
