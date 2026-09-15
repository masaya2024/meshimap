const path = require('node:path');

const { resolveBabelOptions } = require('jest-expo/src/resolveBabelOptions');

/** ソース変換の transform キー。jest-expo のプリセットと同じ値にして差し替える */
const SOURCE_TRANSFORM_PATTERN = '\\.[jt]sx?$';

/**
 * npm は babel-jest@30 の peerDependency を満たすため @babel/core@8 をルートへ巻き上げるが、
 * babel-preset-expo@57 は Babel 7 専用で、Babel 8 から読み込むと変換前に落ちる。
 * jest-expo 同梱の babel-jest（@babel/core@7 を解決する）を明示して回避する。
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
  '@meshimap',
];

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest-setup.ts'],
  transform: {
    [SOURCE_TRANSFORM_PATTERN]: [BABEL_JEST_PATH, resolveBabelOptions(__dirname)],
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
