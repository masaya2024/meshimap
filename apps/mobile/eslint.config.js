// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', '.expo/*'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // docs/CODING_GUIDELINES.md の禁止パターンを機械的に検査する。
      // 型チェックでは捕まえられないため lint 側で止める。
      // console はロガーの sink（src/lib/logger.ts）だけが例外で、そこは disable コメントで明示する
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      // 未使用の import / 変数は tsc の noUnusedLocals でも落ちるが、
      // lint 単体でも検知できるようにしておく（catch 節の引数だけは握り潰しを許す）
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
]);
