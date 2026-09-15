/**
 * @jest-environment node
 */
import { dirname } from 'node:path';

/** package.json のうち、ここで読むフィールドだけを型にする */
interface PackageManifest {
  version: string;
}

/**
 * Babel 7 専用の消費側。いずれも @babel/core を bare な `require` で解決する。
 *
 * - react-native-worklets/plugin: 8 系を掴むと
 *   `Requires Babel "^7.0.0-0", but was loaded with "8.0.5"` でバンドルが落ちる
 * - babel-preset-expo@57: @babel/* を全て `^7` で要求する
 * - react-native-reanimated: 上記 worklets のプラグインを経由する
 */
const BABEL_7_CONSUMERS = [
  'react-native-worklets',
  'babel-preset-expo',
  'react-native-reanimated',
] as const;

const EXPECTED_BABEL_MAJOR = 7;

/** 指定パッケージの位置から見て解決される @babel/core の絶対パスを返す */
function resolveBabelCorePathFrom(consumerPackage: string): string {
  const consumerDirectory = dirname(require.resolve(`${consumerPackage}/package.json`));
  return require.resolve('@babel/core/package.json', { paths: [consumerDirectory] });
}

function readMajorVersion(packageJsonPath: string): number {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const manifest: PackageManifest = require(packageJsonPath);
  const [major] = manifest.version.split('.');
  return Number(major);
}

/**
 * @stryker-mutator/instrumenter が dependencies（peer ではない）で `@babel/core: ~8.0.0` を
 * 要求するため、素直に install するとルートへ 8 系が巻き上げられる。
 * その状態では Metro のバンドルが落ちるが、Jest は Metro を通らないので気づけない。
 * ルート package.json の overrides で 7 系へ固定していることを、ここで回帰テストとして押さえる。
 */
describe('@babel/core のバージョン', () => {
  it.each(BABEL_7_CONSUMERS)('%s から見た @babel/core が 7 系である', (consumerPackage) => {
    const resolvedPath = resolveBabelCorePathFrom(consumerPackage);
    expect(readMajorVersion(resolvedPath)).toBe(EXPECTED_BABEL_MAJOR);
  });

  it('Babel 7 専用パッケージが同一の @babel/core を共有する', () => {
    const resolvedPaths = BABEL_7_CONSUMERS.map(resolveBabelCorePathFrom);
    expect(new Set(resolvedPaths).size).toBe(1);
  });
});
