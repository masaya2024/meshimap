const path = require('node:path');

const { resolveBabelOptions } = require('jest-expo/src/resolveBabelOptions');

/** ソース変換の transform キー。jest-expo のプリセットと同じ値にして差し替える */
const SOURCE_TRANSFORM_PATTERN = '\\.[jt]sx?$';

/**
 * ESM で解決されるパッケージ用の transform キー。
 * jest-expo の既定は `\.[jt]sx?$` だけで .mjs / .cjs を変換対象にしないため、
 * .mjs に解決されるパッケージが require(esm) エラーになる。
 * SOURCE_TRANSFORM_PATTERN とは排他（[mc] が必須）なので二重変換にはならない。
 */
const ESM_TRANSFORM_PATTERN = '\\.[mc]js$';

/**
 * ルートの @babel/core は 8 系。@stryker-mutator/instrumenter が dependencies で
 * `@babel/core: ~8.0.0` を要求しており、それが巻き上げられている
 * （package-lock.json の逆引きで確認。babel-jest の peer は `^7.11.0 || ^8.0.0-0` なので 7 でも満たせる）。
 * 一方 babel-preset-expo@57 は @babel/* を全て ^7 で要求する Babel 7 専用で、
 * Babel 8 から読み込むと変換前に落ちる。
 * jest-expo 同梱の babel-jest（配下の @babel/core@7 を解決する）を明示して回避する。
 * ルートの @babel/core が 7 系に戻ったらこの迂回は削除してよい。
 */
const JEST_EXPO_DIR = path.dirname(require.resolve('jest-expo/package.json'));
const BABEL_JEST_PATH = require.resolve('babel-jest', { paths: [JEST_EXPO_DIR] });

/**
 * CommonJS で配信されていないため変換が必要な node_modules。
 * 前方一致で判定するので `react-native` は react-native-svg / react-native-css-interop も含む。
 */
const TRANSPILED_NODE_MODULES = [
  '.pnpm',
  'react-native',
  '@react-native',
  '@react-native-community',
  'expo',
  '@expo',
  '@expo-google-fonts',
  'react-navigation',
  '@react-navigation',
  '@sentry/react-native',
  'native-base',
  'standard-navigation',
  'nativewind',
  // lucide-react-native は CJS 版も持つが、exports のキー順で `react-native` 条件が
  // `require` より先に来ており、その条件が .mjs を指す。RN の Jest 環境は
  // customExportConditions に 'react-native' を含むため .mjs 側に解決される。
  // 前方一致 'react-native' では先頭一致しないため個別に挙げる
  'lucide-react-native',
  '@meshimap',
];

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest-setup.ts'],
  transform: {
    [SOURCE_TRANSFORM_PATTERN]: [BABEL_JEST_PATH, resolveBabelOptions(__dirname)],
    [ESM_TRANSFORM_PATTERN]: [BABEL_JEST_PATH, resolveBabelOptions(__dirname)],
  },
  transformIgnorePatterns: [
    `/node_modules/(?!(${TRANSPILED_NODE_MODULES.join('|')}))`,
    // babel プラグイン自身を変換すると "Reentrant plugin detected" になるため除外する
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.test.{ts,tsx}', '!src/app/**'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
