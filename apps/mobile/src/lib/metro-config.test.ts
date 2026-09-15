/**
 * @jest-environment node
 */
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 検証に使うところだけを型にする。Metro の設定全体は型に起こさない */
interface MetroConfigShape {
  resolver: {
    blockList: readonly RegExp[];
  };
}

// metro.config.js は CommonJS のため import ではなく require で読み込む
// eslint-disable-next-line @typescript-eslint/no-require-imports
const metroConfig: MetroConfigShape = require('../../metro.config.js');

const APP_DIR = resolve(__dirname, '..', 'app');

const TEST_FILE_SUFFIX = /\.(test|spec)\.[jt]sx?$/;
const SOURCE_FILE_SUFFIX = /\.[jt]sx?$/;

/** ディレクトリを再帰的に辿り、JS/TS ファイルの絶対パスを返す */
function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectSourceFiles(entryPath);
    }
    return SOURCE_FILE_SUFFIX.test(entry.name) ? [entryPath] : [];
  });
}

function isBlockedByMetro(absolutePath: string): boolean {
  return metroConfig.resolver.blockList.some((pattern) => pattern.test(absolutePath));
}

/**
 * expo-router は src/app 配下を require.context で走査し、`+html` / `+api` / `+middleware` 以外は
 * 拡張子が .tsx なら全部ルートとして拾う。テストを画面と共置きすると本番バンドルに
 * @testing-library/react-native が混入し、それが Node 組み込みの `console` を require するため
 * `expo export` がバンドルエラーで落ちる。Metro の blockList で外れていることをここで担保する。
 */
describe('Metro の blockList', () => {
  const appFiles = collectSourceFiles(APP_DIR);
  const testFiles = appFiles.filter((filePath) => TEST_FILE_SUFFIX.test(filePath));
  const implementationFiles = appFiles.filter((filePath) => !TEST_FILE_SUFFIX.test(filePath));

  // 対象が 0 件だと下の 2 本が自明に通ってしまうため、前提そのものを検証する
  it('src/app 配下にテストファイルが存在する', () => {
    expect(testFiles.length).toBeGreaterThan(0);
  });

  it('src/app 配下のテストファイルは全て除外される', () => {
    const notBlocked = testFiles.filter((filePath) => !isBlockedByMetro(filePath));
    expect(notBlocked).toEqual([]);
  });

  it('src/app 配下の画面ファイルは 1 つも除外されない', () => {
    const blocked = implementationFiles.filter((filePath) => isBlockedByMetro(filePath));
    expect(blocked).toEqual([]);
  });
});
