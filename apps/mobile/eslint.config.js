// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', '.expo/*'],
  },
  {
    // ルート直下の設定ファイルは CommonJS で、Node のグローバルを使う。
    // eslint-config-expo の既定はアプリコード（ブラウザ / RN 環境）向けで
    // これらを未定義として扱うため、この 3 つだけをここで許可する。
    // globals パッケージの node プリセットを丸ごと入れないのは、設定ファイルで
    // 実際に使うものだけを明示したいため。
    files: ['eslint.config.js', 'jest.config.js'],
    languageOptions: {
      globals: {
        __dirname: 'readonly',
        module: 'writable',
        require: 'readonly',
      },
    },
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
