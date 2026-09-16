import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Actor の生成関数を import してよいファイル（src/ からの相対パス）。
 * ここを増やすときは「本当に認証経路か」を必ず確認すること。
 *
 * 下の「ホワイトリストに載っているファイルが実在する」検査があるため、
 * **まだ存在しないファイルをここに先に書くことはできない**。
 * 認証経路の `auth/load-actor.ts` は Task 4-6 で作成するので、
 * そのタスクでこの Set に追加すること（追加しないと load-actor.ts 自身が違反として落ちる）。
 */
const ACTOR_FACTORY_ALLOWLIST = new Set(['test/fixtures.ts']);

/** 生成系のシンボル。型だけの import は対象外（型は漏れても権限は作れない） */
const ACTOR_FACTORY_SYMBOLS = new Set(['toActor', 'ANONYMOUS_VIEWER']);

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(fullPath)));
      continue;
    }
    if (entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

/** そのファイルが actor モジュールから値として import しているシンボル名を返す */
function collectValueImportsFromActor(sourceFile: ts.SourceFile): string[] {
  const imported: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const moduleSpecifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier)) {
      continue;
    }
    if (!/(^|\/)actor$/.test(moduleSpecifier.text)) {
      continue;
    }
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) {
      // `import type { OwnerActor } from './actor'` は生成能力を持たないので対象外
      continue;
    }
    const bindings = clause.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) {
        continue;
      }
      imported.push(element.name.text);
    }
  }
  return imported;
}

describe('Actor ファクトリの閉じ込め', () => {
  it('toActor と ANONYMOUS_VIEWER を import してよいのはホワイトリストのファイルだけ', async () => {
    const files = await listSourceFiles(SOURCE_ROOT);
    const violations: string[] = [];

    for (const file of files) {
      const relativePath = path.relative(SOURCE_ROOT, file).split(path.sep).join('/');
      // テストファイル自身と actor.ts 本体は対象外
      if (relativePath.endsWith('.test.ts') || relativePath.endsWith('.type-test.ts')) {
        continue;
      }
      if (relativePath === 'auth/actor.ts') {
        continue;
      }
      if (ACTOR_FACTORY_ALLOWLIST.has(relativePath)) {
        continue;
      }

      const content = await readFile(file, 'utf8');
      const sourceFile = ts.createSourceFile(
        file,
        content,
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.TS,
      );
      for (const name of collectValueImportsFromActor(sourceFile)) {
        if (ACTOR_FACTORY_SYMBOLS.has(name)) {
          violations.push(`${relativePath} が ${name} を import している`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('ホワイトリストに載っているファイルが実在する', async () => {
    // パスを書き間違えると検査が素通りするので、実在確認もテストにする
    const files = await listSourceFiles(SOURCE_ROOT);
    const relativePaths = new Set(
      files.map((file) => path.relative(SOURCE_ROOT, file).split(path.sep).join('/')),
    );
    for (const allowed of ACTOR_FACTORY_ALLOWLIST) {
      expect(relativePaths.has(allowed)).toBe(true);
    }
  });
});
