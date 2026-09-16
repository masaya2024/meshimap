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
 *
 * `middleware/auth.ts` が載っているのは、そこが「セッションが無い＝匿名」を決める
 * 唯一の場所だから。ANONYMOUS_VIEWER は権限を 1 つも持たない値なので、
 * これを他所から作られても権限は増えないが、viewer を決める経路が散ると
 * 「どこで匿名に落ちたのか」を追えなくなるため認証経路に閉じ込める。
 */
const ACTOR_FACTORY_ALLOWLIST = new Set([
  'auth/load-actor.ts',
  'middleware/auth.ts',
  'test/fixtures.ts',
]);

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

/** 名前空間 import に対する違反メッセージ。個別シンボルの文言と混ざらないよう分けている */
const NAMESPACE_IMPORT_REASON = 'actor モジュール全体を名前空間として import している';

/**
 * そのファイルが actor モジュールの生成能力を持ち込んでいれば、違反メッセージを返す。
 *
 * 名前空間 import を別扱いするのは、`import * as actorModule from './actor'` と書けば
 * `actorModule.toActor(...)` で同じ生成ができるのに、名前付き import の検査では
 * 1 つも引っかからないため。ここを見落とすと検査全体が素通りになる。
 */
function collectActorFactoryViolations(sourceFile: ts.SourceFile, relativePath: string): string[] {
  const violations: string[] = [];
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
    if (bindings === undefined) {
      continue;
    }
    if (ts.isNamespaceImport(bindings)) {
      violations.push(`${relativePath} が ${NAMESPACE_IMPORT_REASON}`);
      continue;
    }
    if (!ts.isNamedImports(bindings)) {
      continue;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) {
        continue;
      }
      // `import { toActor as make }` では name が別名になるので、元の名前がある propertyName を優先する
      const originalName = (element.propertyName ?? element.name).text;
      if (ACTOR_FACTORY_SYMBOLS.has(originalName)) {
        violations.push(`${relativePath} が ${originalName} を import している`);
      }
    }
  }
  return violations;
}

describe('検査器そのものの取りこぼし', () => {
  /** 実ファイルを作らずに検査ロジックだけを試すためのヘルパ */
  function violationsOf(code: string): string[] {
    const sourceFile = ts.createSourceFile('probe.ts', code, ts.ScriptTarget.ES2022, true);
    return collectActorFactoryViolations(sourceFile, 'probe.ts');
  }

  it('名前付き import の toActor を捕まえる', () => {
    expect(violationsOf("import { toActor } from './actor';")).toEqual([
      'probe.ts が toActor を import している',
    ]);
  });

  it('名前空間 import も捕まえる', () => {
    // `import * as actorModule from './actor'` は actorModule.toActor(...) と書けるため、
    // 名前付き import と同じだけ生成能力がある。ここを見落とすと検査は素通りする
    expect(violationsOf("import * as actorModule from './actor';")).toEqual([
      'probe.ts が actor モジュール全体を名前空間として import している',
    ]);
  });

  it('別名を付けた import も、元の名前で捕まえる', () => {
    expect(violationsOf("import { toActor as make } from './actor';")).toEqual([
      'probe.ts が toActor を import している',
    ]);
  });

  it('型だけの import は見逃す', () => {
    expect(violationsOf("import type { Actor } from './actor';")).toEqual([]);
    expect(violationsOf("import { type Actor } from './actor';")).toEqual([]);
  });

  it('型ガードなど生成能力のない値 import は見逃す', () => {
    expect(violationsOf("import { isOwnerActor } from './actor';")).toEqual([]);
  });

  it('別モジュールの同名 import は見逃す', () => {
    expect(violationsOf("import { toActor } from './not-actor';")).toEqual([]);
  });
});

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
      violations.push(...collectActorFactoryViolations(sourceFile, relativePath));
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
