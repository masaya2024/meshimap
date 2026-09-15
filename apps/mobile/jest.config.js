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
    [SOURCE_TRANSFORM_PATTERN]: ['babel-jest', resolveBabelOptions(__dirname)],
    [ESM_TRANSFORM_PATTERN]: ['babel-jest', resolveBabelOptions(__dirname)],
  },
  transformIgnorePatterns: [
    `/node_modules/(?!(${TRANSPILED_NODE_MODULES.join('|')}))`,
    // babel プラグイン自身を変換すると "Reentrant plugin detected" になるため除外する
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.test.{ts,tsx}', '!src/app/**'],
  // 型しか持たないファイル（features/auth/types.ts など）はここに残したままでよい。
  // babel が型を消すと中身が空になり istanbul の分母が 0 になるので、表では 0% と
  // 出るが global の集計には 1 行も加わらない（分子も分母も 0）。
  // 除外しないのは、いつか実装が紛れ込んだときに気づけるようにするため。
  // ただしファイル単位の閾値を入れると 0% で落ちるので、そのときは除外が要る。
  //
  // packages/core・packages/geo の vitest.config.ts と同じ思想で 100% を要求する。
  // 現状 src/app/ 以外は実測 100%（下げる余地を作ると、埋め戻す機会は二度と来ない）。
  // src/app/ は collectCoverageFrom で除外済み。画面は Phase 5 以降に作るため、
  // 実装が入るタイミングで除外を外して同じ 100% を課すこと。
  coverageThreshold: {
    global: {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
