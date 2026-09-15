// リポジトリ直下の ESLint 設定。対象は packages/* と apps/api。
// apps/mobile は eslint-config-expo を土台にした独自の設定を持つため、
// ここからは ignores で外し、apps/mobile/eslint.config.js に任せる
// （フラット設定は cwd 直近の 1 ファイルしか読まないので、二重適用にはならない）。
//
// eslint を ^10 ではなく ^9 に固定しているのは、apps/mobile が
// eslint@^9 を devDependency に持っており、ルートで ^10 を入れると
// 同じリポジトリに 2 つのメジャーが同居して挙動が分かれるため。
//
// 拡張子が .mjs なのは、ルートの package.json に "type": "module" が無く
// .js が CommonJS になるため。stryker.base.mjs と同じ理由で ESM に寄せている
// （apps/mobile 側は CommonJS のままでよい。あちらは別の設定ファイル）。
import tseslint from 'typescript-eslint';

/**
 * 型情報を使うルールを当てられるファイル。
 * 各 tsconfig.json の include に入っているものだけを並べる。
 * ここから外れたファイルを型付きで検査させると
 * 「TSConfig does not include this file」で落ちる。
 */
const TYPE_CHECKED_FILES = [
  'packages/*/src/**/*.ts',
  'apps/api/src/**/*.ts',
  'apps/api/scripts/**/*.ts',
];

/** 実装コード。テストと設定ファイルには課さない規約をここに当てる */
const SOURCE_FILES = ['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts'];

/** テストコード。実装より緩める必要があるものだけをここで外す */
const TEST_FILES = ['**/*.test.ts'];

/** tsconfig の外にある設定ファイル。型情報なしで検査する */
const CONFIG_FILES = ['*.mjs', '**/*.config.ts', '**/*.config.mjs'];

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      '**/node_modules/',
      // 独自の設定を持つので対象外
      'apps/mobile/',
      // 生成物
      '**/dist/',
      '**/coverage/',
      '**/reports/',
      '**/.wrangler/',
      '**/.expo/',
      // Stryker が変異ごとに作る使い捨てのリポジトリ複製。
      // 実行が中断されると残り、`npx eslint .` が複製側のソースまで検査して落ちる
      // （サンドボックスの stryker.config.mjs と vitest.config.ts には
      // Stryker が @ts-nocheck を差し込むため ban-ts-comment に必ず当たる）。
      '**/.stryker-tmp/',
      // Drizzle が生成する SQL とメタデータ
      'apps/api/migrations/',
      // wrangler types が生成する巨大な .d.ts
      '**/worker-configuration.d.ts',
    ],
  },

  // 型情報を使わない基本セット。全対象ファイルに当てる
  ...tseslint.configs.recommended,

  // 型情報を使うセット。tsconfig に含まれるファイルにだけ当てる
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: TYPE_CHECKED_FILES,
  })),
  {
    files: TYPE_CHECKED_FILES,
    languageOptions: {
      parserOptions: {
        // 各ワークスペースの tsconfig.json を ESLint 側で自動解決させる。
        // project に配列でパスを列挙する書き方だと、ワークスペースが増えるたびに
        // ここを直す必要があり、忘れると無言で型付きルールが効かなくなる。
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    // docs/CODING_GUIDELINES.md 2 章の禁止パターンのうち、
    // tsc では捕まえられないものを lint 側で止める。
    // 未使用の import / 変数は noUnusedLocals・noUnusedParameters でも落ちるが、
    // lint 単体でも検知できるようにしておく（apps/mobile 側と同じ方針）。
    files: ['**/*.ts', '**/*.mjs'],
    rules: {
      // console はロガー経由にする。ここに例外を作るときは
      // disable コメントで「なぜ sink なのか」を書くこと
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // `!` は「型は知らないが自分は知っている」の宣言で、根拠が残らない。
      // 早期 return か noUncheckedIndexedAccess に沿った分岐で書く。
      // 2026-09-15 時点で該当箇所は 0 件。増やさないための固定。
      '@typescript-eslint/no-non-null-assertion': 'error',
      // オブジェクトリテラルへの `as` だけを禁じる。`{ a: 1 } as Shop` は
      // プロパティの過不足を黙って通すため、実質 any と同じ危険がある。
      //
      // `as` 全体を禁じないのは、ブランド型の生成（`return value as ShopId`）が
      // 規約で明示的に許されている唯一の書き方で、2026-09-15 時点の
      // 非テストコード 13 箇所がすべてこれに当たるため。全面禁止にすると
      // 13 個の disable コメントが並ぶだけで、危険な `as` は逆に埋もれる。
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],
    },
  },

  {
    // デフォルトエクスポートは import 側で名前を自由に付けられるため、
    // 同じものが別名で呼ばれて grep が効かなくなる。
    // 設定ファイル（vitest.config.ts など）は仕様上 default が必須なので、
    // 実装コードにだけ課す。
    files: SOURCE_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message:
            'デフォルトエクスポートは禁止。名前付きエクスポートにすること（docs/CODING_GUIDELINES.md 2 章）。',
        },
      ],
    },
  },

  {
    // テストは「壊れた値」を意図的に作るため、実装と同じ厳しさにできない。
    files: TEST_FILES,
    rules: {
      // 型を外れた入力を渡して例外を確かめるテストがある。
      // 実装側の禁止は上の設定で効いたままにする
      '@typescript-eslint/no-explicit-any': 'off',
      // 期待値をその場に書き下すテストでは `{...} as T` に意味がある
      '@typescript-eslint/consistent-type-assertions': 'off',
    },
  },

  {
    // tsconfig の include の外にある設定ファイル。型付きルールは当たらない。
    // stryker.base.mjs などは Node のグローバルを使う
    files: CONFIG_FILES,
    languageOptions: {
      globals: {
        // ESM なので __dirname / require は無い。使うのは process だけ
        process: 'readonly',
      },
    },
  },
);
