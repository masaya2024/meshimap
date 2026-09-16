import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * リポジトリ層の規約をソースコードそのものに対して機械的に検査する。
 *
 * 設計書 3.2 の二層防御のうち「Actor を第 2 引数として必ず受け取る」という型側の担保は、
 * 新しい関数を 1 つ書き忘れるだけで穴が開く。レビューに頼らず、ここで構文レベルで落とす。
 *
 * `import.meta.dirname` ではなく fileURLToPath を使う理由:
 * グローバルの `URL` が @cloudflare/workers-types のものに差し替わっているため
 * `readFileSync(new URL(...))` は TS2769 になる。src/auth/actor-encapsulation.test.ts と同じ形に揃える。
 */
const REPOSITORIES_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 第 2 引数に許される型名。src/auth/actor.ts の export と一致させること */
const ACTOR_TYPE_NAMES = new Set(['UserActor', 'OwnerActor', 'AdminActor', 'Actor', 'Viewer']);
/** 未使用引数は noUnusedParameters を満たすため `_` を付ける。引数を要求すること自体が目的なので削らない */
const ACTOR_PARAMETER_NAMES = new Set(['actor', '_actor', 'viewer', '_viewer']);
const DB_PARAMETER_NAME = 'db';
const DB_TYPE_NAME = 'Database';
/** 本番の D1 に対話的トランザクションは無い。ローカルの miniflare では通ってしまうので構文で禁じる */
const FORBIDDEN_TRANSACTION_CALL = 'db.transaction(';

type ExportedSignature = {
  readonly name: string;
  readonly parameters: ts.NodeArray<ts.ParameterDeclaration>;
};

type ExportScanResult = {
  readonly signatures: ExportedSignature[];
  readonly violations: string[];
};

function isFunctionLiteral(node: ts.Expression): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/**
 * 「関数が隠れている余地がない値」かどうか。
 * `export const findShop = makeFinder(shops)` のような間接参照は引数が構文に現れず、
 * 検査を素通りする抜け道になるため、リテラル以外の初期化子は一律で違反にする。
 */
function isLiteralConstant(node: ts.Expression): boolean {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return isLiteralConstant(node.expression);
  }
  if (ts.isPrefixUnaryExpression(node)) {
    return isLiteralConstant(node.operand);
  }
  return (
    ts.isNumericLiteral(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isArrayLiteralExpression(node) ||
    ts.isObjectLiteralExpression(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

/**
 * ファイル内のトップレベル関数を export の有無に関わらず索引する。
 * `export { findShop }` 形式の公開では宣言側に export 修飾子が付かないため、
 * 修飾子だけを見ていると実体を見失う。
 * オーバーロードがあると同じ名前に複数のシグネチャがぶら下がるので配列で持つ。
 */
function indexLocalCallables(sourceFile: ts.SourceFile): Map<string, ExportedSignature[]> {
  const index = new Map<string, ExportedSignature[]>();
  const add = (name: string, parameters: ts.NodeArray<ts.ParameterDeclaration>): void => {
    const current = index.get(name) ?? [];
    current.push({ name, parameters });
    index.set(name, current);
  };

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      add(statement.name.text, statement.parameters);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (
          initializer !== undefined &&
          isFunctionLiteral(initializer) &&
          ts.isIdentifier(declaration.name)
        ) {
          add(declaration.name.text, initializer.parameters);
        }
      }
    }
  }
  return index;
}

/** `export { a as b }` の再エクスポートを、同じファイル内の宣言まで辿って解決する */
function resolveReExport(
  statement: ts.ExportDeclaration,
  clause: ts.NamedExports,
  localCallables: Map<string, ExportedSignature[]>,
  label: string,
): ExportScanResult {
  const signatures: ExportedSignature[] = [];
  const violations: string[] = [];

  for (const specifier of clause.elements) {
    if (specifier.isTypeOnly) {
      continue;
    }
    const exportedName = specifier.name.text;
    if (statement.moduleSpecifier !== undefined) {
      // 署名が別ファイルにあるので、このファイルだけを見る検査器では中身を確かめられない
      violations.push(
        `${label}: ${exportedName} を別モジュールから再エクスポートしている（署名が検査から外れる）`,
      );
      continue;
    }
    // import の別名と同じく、ローカル側の名前は propertyName に入る（`export { local as public }`）
    const localName = (specifier.propertyName ?? specifier.name).text;
    const resolved = localCallables.get(localName);
    if (resolved === undefined) {
      violations.push(`${label}: ${exportedName} の実体を同じファイル内に解決できない`);
      continue;
    }
    for (const signature of resolved) {
      signatures.push({ name: exportedName, parameters: signature.parameters });
    }
  }
  return { signatures, violations };
}

/**
 * export された「関数」だけを拾う。`export type` / 非関数の `export const` は対象外。
 * オーバーロード宣言は実装シグネチャとは別の公開された呼び出し口なので、1 つずつ拾う
 * （実装だけを見ると、Actor を取らないオーバーロードが公開されたまま素通りする）。
 */
function scanExports(sourceFile: ts.SourceFile, label: string): ExportScanResult {
  const signatures: ExportedSignature[] = [];
  const violations: string[] = [];
  const localCallables = indexLocalCallables(sourceFile);

  for (const statement of sourceFile.statements) {
    // `export default findShop;` は修飾子を持たない ExportAssignment なので個別に見る
    if (ts.isExportAssignment(statement)) {
      violations.push(`${label}: default export は禁止`);
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) {
        // 型だけの再エクスポートは実行時の呼び出し口を増やさない
        continue;
      }
      const clause = statement.exportClause;
      if (clause === undefined) {
        violations.push(`${label}: export * による再エクスポートは禁止（署名が検査から外れる）`);
        continue;
      }
      if (ts.isNamespaceExport(clause)) {
        violations.push(`${label}: export * as による再エクスポートは禁止（署名が検査から外れる）`);
        continue;
      }
      const resolved = resolveReExport(statement, clause, localCallables, label);
      signatures.push(...resolved.signatures);
      violations.push(...resolved.violations);
      continue;
    }

    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      continue;
    }
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
      // 規約で default export は禁止。中身も続けて検査したいので continue しない
      violations.push(`${label}: default export は禁止`);
    }

    if (ts.isClassDeclaration(statement)) {
      violations.push(`${label}: class の export は禁止（リポジトリ層は関数だけを export する）`);
      continue;
    }

    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      signatures.push({ name: statement.name.text, parameters: statement.parameters });
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          violations.push(`${label}: 分割代入による export は禁止`);
          continue;
        }
        const name = declaration.name.text;
        const initializer = declaration.initializer;
        if (initializer !== undefined && isFunctionLiteral(initializer)) {
          signatures.push({ name, parameters: initializer.parameters });
          continue;
        }
        if (initializer === undefined || !isLiteralConstant(initializer)) {
          violations.push(
            `${label}: ${name} は関数リテラルでもリテラル定数でもない値を export している（関数が隠れていても検査できない）`,
          );
        }
      }
    }
  }
  return { signatures, violations };
}

function parameterTypeName(parameter: ts.ParameterDeclaration): string | null {
  const typeNode = parameter.type;
  if (typeNode === undefined || !ts.isTypeReferenceNode(typeNode)) {
    return null;
  }
  const typeName = typeNode.typeName;
  return ts.isIdentifier(typeName) ? typeName.text : null;
}

function parameterName(parameter: ts.ParameterDeclaration): string | null {
  return ts.isIdentifier(parameter.name) ? parameter.name.text : null;
}

/**
 * 規約違反を人間が読める文字列の配列で返す。空配列なら合格。
 *
 * ソースファイルだけを見る純関数にしてあるので、実ファイルを作らずに
 * `ts.createSourceFile` した文字列で検査器そのものをテストできる。
 */
export function collectConventionViolations(sourceFile: ts.SourceFile, label: string): string[] {
  const violations: string[] = [];

  if (sourceFile.text.includes(FORBIDDEN_TRANSACTION_CALL)) {
    violations.push(`${label}: ${FORBIDDEN_TRANSACTION_CALL} を使っている`);
  }

  const scanned = scanExports(sourceFile, label);
  violations.push(...scanned.violations);
  if (scanned.signatures.length === 0) {
    violations.push(`${label}: export された関数が 1 つも無い`);
  }

  for (const signature of scanned.signatures) {
    const first = signature.parameters[0];
    const second = signature.parameters[1];
    if (first === undefined || second === undefined) {
      violations.push(`${label}: ${signature.name} の引数が 2 つ未満（db と actor が必須）`);
      continue;
    }
    if (parameterName(first) !== DB_PARAMETER_NAME || parameterTypeName(first) !== DB_TYPE_NAME) {
      violations.push(`${label}: ${signature.name} の第 1 引数が db: Database ではない`);
    }
    const secondName = parameterName(second);
    if (secondName === null || !ACTOR_PARAMETER_NAMES.has(secondName)) {
      violations.push(
        `${label}: ${signature.name} の第 2 引数名が actor / viewer ではない（${String(secondName)}）`,
      );
    }
    const secondType = parameterTypeName(second);
    if (secondType === null || !ACTOR_TYPE_NAMES.has(secondType)) {
      violations.push(
        `${label}: ${signature.name} の第 2 引数の型が Actor 系ではない（${String(secondType)}）`,
      );
    }
  }
  return violations;
}

function parseSource(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

/** 実ファイルを読んで検査する薄いラッパ。ファイル入出力をここだけに閉じ込める */
function violationsOfFile(fileName: string): string[] {
  const filePath = path.join(REPOSITORIES_DIR, fileName);
  const source = readFileSync(filePath, 'utf8');
  return collectConventionViolations(parseSource(filePath, source), fileName);
}

function listRepositoryFiles(): string[] {
  return readdirSync(REPOSITORIES_DIR)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => !name.endsWith('.test.ts'));
}

describe('検査器そのものの取りこぼし', () => {
  /** 実ファイルを作らずに検査ロジックだけを試すためのヘルパ */
  function violationsOf(code: string): string[] {
    return collectConventionViolations(parseSource('probe.ts', code), 'probe.ts');
  }

  const COMPLIANT_SOURCE = `
import type { Database } from '../db/client';

export type ShopRow = { readonly id: string };
export const SOME_CONSTANT = 1;

function notExported(value: number): number {
  return value;
}

export async function listThings(db: Database, viewer: Viewer, limit?: number): Promise<ShopRow[]> {
  return [];
}

export async function updateThingAsOwner(db: Database, actor: OwnerActor, id: ShopId): Promise<null> {
  return null;
}

export async function deleteThingAsAdmin(db: Database, _actor: AdminActor, id: ShopId): Promise<boolean> {
  return false;
}

export const arrowGood = async (db: Database, viewer: Viewer): Promise<void> => {};
`;

  it('規約を満たすソースには違反を出さない', () => {
    expect(violationsOf(COMPLIANT_SOURCE)).toEqual([]);
  });

  it('Actor を取らない関数を違反として検出する', () => {
    const violations = violationsOf(
      'export async function noActor(db: Database, shopId: ShopId): Promise<void> {}',
    );
    expect(violations.join('\n')).toContain('noActor の第 2 引数名が actor / viewer ではない');
  });

  it('引数順が逆の関数を違反として検出する', () => {
    const violations = violationsOf(
      'export async function wrongOrder(actor: OwnerActor, db: Database): Promise<void> {}',
    );
    expect(violations.join('\n')).toContain('wrongOrder の第 1 引数が db: Database ではない');
  });

  it('第 2 引数の型が string の関数を違反として検出する', () => {
    const violations = violationsOf(
      'export async function stringActor(db: Database, actor: string): Promise<void> {}',
    );
    expect(violations.join('\n')).toContain('stringActor の第 2 引数の型が Actor 系ではない');
  });

  it('引数を取らない関数を違反として検出する', () => {
    const violations = violationsOf('export async function noParams(): Promise<void> {}');
    expect(violations.join('\n')).toContain('noParams の引数が 2 つ未満');
  });

  it('アロー関数の export も検査する', () => {
    // `export const fn = (...) => {}` は FunctionDeclaration ではないので、
    // 関数宣言だけを見ていると 1 件も引っかからない
    const violations = violationsOf(
      'export const arrowBad = async (db: Database, shopId: ShopId): Promise<void> => {};',
    );
    expect(violations.join('\n')).toContain('arrowBad の第 2 引数名が actor / viewer ではない');
  });

  it('関数式の export も検査する', () => {
    const violations = violationsOf(
      'export const expressionBad = async function (db: Database, shopId: ShopId) {};',
    );
    expect(violations.join('\n')).toContain(
      'expressionBad の第 2 引数名が actor / viewer ではない',
    );
  });

  it('db.transaction( を違反として検出する', () => {
    const violations = violationsOf(
      [
        'export async function usesTransaction(db: Database, actor: AdminActor): Promise<void> {',
        '  await db.transaction(async () => {});',
        '}',
      ].join('\n'),
    );
    expect(violations.join('\n')).toContain('db.transaction( を使っている');
  });

  it('export された関数が無いファイルを違反として検出する', () => {
    const violations = violationsOf(
      [
        'export type OnlyAType = { readonly id: string };',
        'export const ONLY_A_CONSTANT = 1;',
        'function notExported(): void {}',
      ].join('\n'),
    );
    expect(violations.join('\n')).toContain('export された関数が 1 つも無い');
  });

  it('オーバーロード宣言も 1 つずつ検査する', () => {
    // 実装シグネチャは規約を満たしているので、実装だけを見ると 1 件も引っかからない。
    // だが 1 本目のオーバーロードは Actor を取らない呼び出し口として公開されている
    const violations = violationsOf(
      [
        'export function findShop(db: Database, shopId: ShopId): null;',
        'export function findShop(db: Database, viewer: Viewer, shopId: ShopId): null;',
        'export function findShop(db: Database, viewer: Viewer, shopId?: ShopId): null {',
        '  return null;',
        '}',
      ].join('\n'),
    );
    expect(violations.join('\n')).toContain(
      'findShop の第 2 引数名が actor / viewer ではない（shopId）',
    );
  });

  it('すべてのオーバーロードが規約を満たしていれば通す', () => {
    const violations = violationsOf(
      [
        'export function findShop(db: Database, viewer: Viewer): null;',
        'export function findShop(db: Database, viewer: Viewer, shopId: ShopId): null;',
        'export function findShop(db: Database, viewer: Viewer, shopId?: ShopId): null {',
        '  return null;',
        '}',
      ].join('\n'),
    );
    expect(violations).toEqual([]);
  });

  it('default export を違反として検出する（宣言形）', () => {
    const violations = violationsOf(
      'export default async function findShop(db: Database, viewer: Viewer): Promise<void> {}',
    );
    expect(violations.join('\n')).toContain('default export は禁止');
  });

  it('default export を違反として検出する（代入形）', () => {
    // `export default findShop` は ExportAssignment なので、修飾子だけを見ていると素通りする
    const violations = violationsOf(
      [
        'async function findShop(db: Database, viewer: Viewer): Promise<void> {}',
        'export default findShop;',
      ].join('\n'),
    );
    expect(violations.join('\n')).toContain('default export は禁止');
  });

  it('同じファイル内の関数を export { } で公開しても検査する', () => {
    // 宣言側に export 修飾子が付かないので、修飾子だけを見ていると素通りする
    const violations = violationsOf(
      [
        'async function findShop(db: Database, shopId: ShopId): Promise<void> {}',
        'export { findShop };',
      ].join('\n'),
    );
    expect(violations.join('\n')).toContain('findShop の第 2 引数名が actor / viewer ではない');
  });

  it('別名を付けた export { x as y } も、元の宣言を辿って検査する', () => {
    const violations = violationsOf(
      [
        'async function findShop(db: Database, shopId: ShopId): Promise<void> {}',
        'export { findShop as lookupShop };',
      ].join('\n'),
    );
    expect(violations.join('\n')).toContain('lookupShop の第 2 引数名が actor / viewer ではない');
  });

  it('別名を付けた export { x as y } は規約を満たしていれば通す', () => {
    const violations = violationsOf(
      [
        'async function findShop(db: Database, viewer: Viewer): Promise<void> {}',
        'export { findShop as lookupShop };',
      ].join('\n'),
    );
    expect(violations).toEqual([]);
  });

  it('別モジュールからの再エクスポートを違反として検出する', () => {
    // 署名が別ファイルにあるので、このファイルだけを見る検査器では中身を確かめようがない
    const violations = violationsOf("export { findShop } from '../db/queries/nearby-shops';");
    expect(violations.join('\n')).toContain('findShop を別モジュールから再エクスポートしている');
  });

  it('export * を違反として検出する', () => {
    const violations = violationsOf("export * from '../db/queries/nearby-shops';");
    expect(violations.join('\n')).toContain('export * による再エクスポートは禁止');
  });

  it('export * as を違反として検出する', () => {
    const violations = violationsOf("export * as queries from '../db/queries/nearby-shops';");
    expect(violations.join('\n')).toContain('export * as による再エクスポートは禁止');
  });

  it('型だけの再エクスポートは見逃す', () => {
    const violations = violationsOf(
      [
        "export type { ShopRow } from './shop-repository';",
        'export async function listThings(db: Database, viewer: Viewer): Promise<void> {}',
      ].join('\n'),
    );
    expect(violations).toEqual([]);
  });

  it('関数リテラル以外の値を export していたら違反として検出する', () => {
    // `export const findShop = makeFinder(shops)` は関数を返しうるのに
    // 引数が構文に現れないため、検査を素通りさせる抜け道になる
    const violations = violationsOf(
      [
        'export const findShop = makeFinder(shops);',
        'export async function listThings(db: Database, viewer: Viewer): Promise<void> {}',
      ].join('\n'),
    );
    expect(violations.join('\n')).toContain('findShop は関数リテラルでもリテラル定数でもない');
  });

  it('class の export を違反として検出する', () => {
    const violations = violationsOf(
      [
        'export class ShopRepository {',
        '  find(shopId: ShopId): null {',
        '    return null;',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(violations.join('\n')).toContain('class の export は禁止');
  });
});

describe('リポジトリ層の規約', () => {
  const files = listRepositoryFiles();

  it('走査対象のリポジトリファイルが 1 つ以上ある', () => {
    // 対象がゼロだと以下の it.each が 0 件になり、何も検査していないのに緑になる
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s は規約を満たす', (fileName) => {
    expect(violationsOfFile(fileName)).toEqual([]);
  });
});
