# Phase 0: モノレポ基盤 / デザインシステム 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** NativeWind・Google Fonts・テーマ定数・UI プリミティブ 7 種を揃え、以降の全画面が同じ部品の上に積める状態にする。

**Architecture:** `apps/mobile/src/components/ui/` にドメインを知らないプリミティブを置き、テーマ値は `constants/theme.ts` に一元化して Tailwind 側にも同じ値を流し込む。各プリミティブは React Native Testing Library でテストし、`app/_dev/catalog.tsx` で一覧確認できるようにする。

**Tech Stack:** Expo SDK 57 / React Native 0.86.3 / React 19.2.3 / TypeScript 6.0 / NativeWind 4.2.7 / Tailwind CSS 3.4.19 / lucide-react-native 1.46 / Jest 30 + jest-expo 57 + @testing-library/react-native 14

## Global Constraints

- ファイル名・ディレクトリ名は **kebab-case**（例外なし）
- コンポーネント名は **PascalCase**、関数・変数は **camelCase**、定数は **UPPER_SNAKE_CASE**
- `any` 禁止・`console.log` 禁止・マジックナンバー禁止（`constants/` に定義する）
- デフォルトエクスポート禁止（expo-router の画面ファイルのみ例外）
- 数値には単位を名前に含める（`radiusM`, `slotMinutes`, `DEFAULT_TIMEOUT_MS`）
- コメントは日本語で、「なぜ」を書く
- テスト名は日本語で振る舞いを記述する
- 作業ディレクトリはリポジトリルート `/Users/hattori/Downloads/alee`。モバイル向けコマンドは `-w @meshimap/mobile` を付ける
- Node は 22.23.2（`.nvmrc`）。ターミナルを開くたび `nvm use` を実行する

---

### Task 0-1: NativeWind をセットアップする

**Files:**

- Create: `apps/mobile/babel.config.js`
- Create: `apps/mobile/metro.config.js`
- Create: `apps/mobile/tailwind.config.js`
- Create: `apps/mobile/nativewind-env.d.ts`
- Modify: `apps/mobile/src/global.css`
- Modify: `apps/mobile/src/app/index.tsx`（動作確認のため一時的に className を付ける）

**Interfaces:**

- Consumes: なし（最初のタスク）
- Produces: `className` プロパティが React Native コンポーネントで使えるようになる

- [x] **Step 1: babel.config.js を作る**

`nativewind/babel` プリセットと、`babel-preset-expo` への `jsxImportSource` 指定の両方が必要。

```js
// apps/mobile/babel.config.js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { jsxImportSource: 'nativewind' }], 'nativewind/babel'],
  };
};
```

- [x] **Step 2: metro.config.js を作る**

```js
// apps/mobile/metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

// Expo SDK 52 以降はモノレポを自動検出するため watchFolders / nodeModulesPaths の手動設定は不要
const config = getDefaultConfig(__dirname);

module.exports = withNativeWind(config, { input: './src/global.css' });
```

- [x] **Step 3: tailwind.config.js を作る**

`content` には `src` 配下の tsx を全て含める。テーマ値は Task 0-3 で追加するのでここでは空。

```js
// apps/mobile/tailwind.config.js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {},
  },
  plugins: [],
};
```

- [x] **Step 4: global.css に Tailwind ディレクティブを追加する**

既存の CSS 変数定義は残したまま、先頭にディレクティブを足す。

```css
/* apps/mobile/src/global.css の先頭に追加 */
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [x] **Step 5: 型定義ファイルを作る**

```ts
// apps/mobile/nativewind-env.d.ts
/// <reference types="nativewind/types" />
```

- [x] **Step 6: tsconfig.json の include に追加する**

`apps/mobile/tsconfig.json` の `include` 配列に `"nativewind-env.d.ts"` を足す。

- [x] **Step 7: 動作確認する**

`apps/mobile/src/app/index.tsx` の最外周の View に `className="flex-1 items-center justify-center bg-red-500"` を付け、
`npm run mobile` で起動して**画面が赤く塗りつぶされること**を目視確認する。
確認できたら className を元に戻す。

理由: NativeWind は babel / metro / tailwind の 3 箇所が揃わないと無言で効かない。
最初に「明らかに見て分かる変化」で疎通を取る。

- [x] **Step 8: 型チェックが通ることを確認する**

Run: `npm run typecheck -w @meshimap/mobile`
Expected: エラーなし

- [x] **Step 9: コミットする**

```bash
git add apps/mobile/babel.config.js apps/mobile/metro.config.js apps/mobile/tailwind.config.js \
        apps/mobile/nativewind-env.d.ts apps/mobile/src/global.css apps/mobile/tsconfig.json
git commit -m "feat(mobile): NativeWind をセットアップする"
```

---

### Task 0-2: テーマ定数を定義する

**Files:**

- Create: `apps/mobile/src/constants/theme.ts`
- Create: `apps/mobile/src/constants/theme.test.ts`

**Interfaces:**

- Consumes: なし
- Produces: `COLORS`, `SPACING`, `RADIUS`, `FONT_SIZES`, `Z_INDEX`, `SEMANTIC_COLORS`

- [x] **Step 1: 失敗するテストを書く**

```ts
// apps/mobile/src/constants/theme.test.ts
import { COLORS, RADIUS, SEMANTIC_COLORS, SPACING } from './theme';

describe('theme 定数', () => {
  it('primary は炭火のオレンジレッド #E2553D を指す', () => {
    expect(COLORS.primary[500]).toBe('#E2553D');
  });

  it('カラースケールは 50 から 900 まで欠番なく定義されている', () => {
    const expectedSteps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900];
    expect(Object.keys(COLORS.primary).map(Number)).toEqual(expectedSteps);
  });

  it('SPACING は 4px 刻みで定義されている', () => {
    expect(SPACING.xs).toBe(4);
    expect(SPACING.sm).toBe(8);
    expect(SPACING.md).toBe(16);
  });

  it('営業状態の意味色が 4 種すべて定義されている', () => {
    expect(SEMANTIC_COLORS.open).toBeDefined();
    expect(SEMANTIC_COLORS.closingSoon).toBeDefined();
    expect(SEMANTIC_COLORS.closed).toBeDefined();
    expect(SEMANTIC_COLORS.regularHoliday).toBeDefined();
  });

  it('カードの標準角丸は 16px', () => {
    expect(RADIUS.card).toBe(16);
  });
});
```

- [x] **Step 2: テストが失敗することを確認する**

Run: `npm test -w @meshimap/mobile -- theme`
Expected: FAIL（`Cannot find module './theme'`）

- [x] **Step 3: theme.ts を実装する**

```ts
// apps/mobile/src/constants/theme.ts

/**
 * 配色。primary は炭火で焼いた食材の色を想定した暖色系。
 * 食欲を喚起しつつ、食べログのオレンジとは意図的にずらしている。
 */
export const COLORS = {
  primary: {
    50: '#FEF3F0',
    100: '#FDE3DC',
    200: '#FAC4B7',
    300: '#F39B85',
    400: '#EB7458',
    500: '#E2553D',
    600: '#C43F29',
    700: '#A02F1D',
    800: '#7C2515',
    900: '#5A1B0F',
  },
  neutral: {
    50: '#FAF9F7',
    100: '#F2F0ED',
    200: '#E4E1DC',
    300: '#CFCAC2',
    400: '#A8A29A',
    500: '#7C766E',
    600: '#5C574F',
    700: '#443F39',
    800: '#2C2823',
    900: '#1A1714',
  },
  amber: { 50: '#FFFAEB', 400: '#FBBF24', 500: '#F59E0B', 700: '#B45309' },
  green: { 50: '#ECFDF5', 500: '#10B981', 700: '#047857' },
  red: { 50: '#FEF2F2', 500: '#EF4444', 700: '#B91C1C' },
  /** 純白。neutral[50] は暖色寄りなので、カード面やボタン文字にはこちらを使う */
  white: '#FFFFFF',
} as const;

/** 意味を持つ色。用途が変わっても呼び出し側を書き換えずに済むよう別名で持つ */
export const SEMANTIC_COLORS = {
  open: COLORS.green[500],
  closingSoon: COLORS.amber[500],
  closed: COLORS.neutral[400],
  regularHoliday: COLORS.neutral[500],
  rating: COLORS.amber[400],
  danger: COLORS.red[500],
} as const;

/** 余白。4px を基本単位にする */
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

/** 角丸。カードは 16px で統一する */
export const RADIUS = {
  sm: 8,
  md: 12,
  card: 16,
  pill: 999,
} as const;

export const FONT_SIZES = {
  xs: 11,
  sm: 13,
  base: 15,
  lg: 17,
  xl: 20,
  xxl: 24,
  display: 32,
} as const;

/** 地図上の重なり順。ボトムシートがマーカーより手前に来る必要がある */
export const Z_INDEX = {
  mapMarker: 10,
  mapOverlayButton: 20,
  bottomSheet: 30,
  modal: 40,
  toast: 50,
} as const;
```

- [x] **Step 4: テストが通ることを確認する**

Run: `npm test -w @meshimap/mobile -- theme`
Expected: PASS（5 件）

- [x] **Step 5: コミットする**

```bash
git add apps/mobile/src/constants/theme.ts apps/mobile/src/constants/theme.test.ts
git commit -m "feat(mobile): テーマ定数を定義する"
```

---

### Task 0-3: Tailwind にテーマ値を流し込む

**Files:**

- Modify: `apps/mobile/tailwind.config.js`

**Interfaces:**

- Consumes: `constants/theme.ts` の `COLORS`
- Produces: `bg-primary-500`, `text-neutral-700`, `rounded-card`, `font-display`, `font-body` などのクラス

- [x] **Step 1: tailwind.config.js を書き換える**

`theme.ts` は TypeScript なので Tailwind の設定（CommonJS）からは直接 import できない。
**値を二重管理しない**ため、色は JS 側で定義して `theme.ts` から参照する形にはせず、
Tailwind 側には同じ値を明示的に書き、Task 0-2 のテストで同期を検証する方針を取る。

```js
// apps/mobile/tailwind.config.js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#FEF3F0',
          100: '#FDE3DC',
          200: '#FAC4B7',
          300: '#F39B85',
          400: '#EB7458',
          500: '#E2553D',
          600: '#C43F29',
          700: '#A02F1D',
          800: '#7C2515',
          900: '#5A1B0F',
        },
        neutral: {
          50: '#FAF9F7',
          100: '#F2F0ED',
          200: '#E4E1DC',
          300: '#CFCAC2',
          400: '#A8A29A',
          500: '#7C766E',
          600: '#5C574F',
          700: '#443F39',
          800: '#2C2823',
          900: '#1A1714',
        },
        // 以下は Tailwind 既定のスケールと同名だが値が異なる（green は既定の green ではなく
        // emerald 相当）。明示しないと className 側だけ既定色になり theme.ts と食い違う
        amber: { 50: '#FFFAEB', 400: '#FBBF24', 500: '#F59E0B', 700: '#B45309' },
        green: { 50: '#ECFDF5', 500: '#10B981', 700: '#047857' },
        red: { 50: '#FEF2F2', 500: '#EF4444', 700: '#B91C1C' },
        white: '#FFFFFF',
      },
      borderRadius: {
        card: '16px',
      },
      fontFamily: {
        // Task 0-4 で読み込むフォント名と一致させる
        display: ['Outfit_600SemiBold'],
        'display-bold': ['Outfit_700Bold'],
        body: ['NotoSansJP_400Regular'],
        'body-medium': ['NotoSansJP_500Medium'],
        'body-bold': ['NotoSansJP_700Bold'],
      },
      // Tailwind 既定の text-xs/sm/base/lg/xl を同名で上書きする。
      // 上書きしないと text-base が既定の 16px になり、FONT_SIZES.base の 15px と食い違う
      fontSize: {
        xs: '11px',
        sm: '13px',
        base: '15px',
        lg: '17px',
        xl: '20px',
        xxl: '24px',
        display: '32px',
      },
      // 数値の Tailwind 既定スケール（p-4 など）に加えて意味で引ける別名を足す
      spacing: {
        xs: '4px',
        sm: '8px',
        md: '16px',
        lg: '24px',
        xl: '32px',
        xxl: '48px',
      },
      // 重なり順は用途名で指定する。キー名は theme.ts と同じ camelCase（z-bottomSheet）
      zIndex: {
        mapMarker: '10',
        mapOverlayButton: '20',
        bottomSheet: '30',
        modal: '40',
        toast: '50',
      },
    },
  },
  plugins: [],
};
```

> **なぜ fontSize を必ず上書きするか**
> Tailwind の既定値は `text-base` = 16px / `text-sm` = 14px / `text-xs` = 12px。
> 本プロジェクトの `FONT_SIZES` は 15 / 13 / 11px なので、上書きしないと
> `text-base` を書いた全コンポーネントが設計と 1px ずれる。しかもクラス名は
> 有効なので**エラーにならず静かにずれる**。同期テストでこれを固定する。

> **なぜ amber / green / red / white も必ず書くか**
> `fontSize` と同じ罠が色にもある。`COLORS.amber` `COLORS.green` `COLORS.red` は
> Tailwind の同名スケールと**値が違う**（`COLORS.green` は既定の green ではなく emerald 相当）。
> Tailwind 側に書かないと `className="bg-green-50"` だけ既定色になり、
> JS から `SEMANTIC_COLORS.open` を渡した箇所と別の色になる。実測での差分は次の 3 件:
>
> | クラス           | 未定義時（Tailwind 既定） | `theme.ts` |
> | ---------------- | ------------------------- | ---------- |
> | `bg-amber-50`    | `#FFFBEB`                 | `#FFFAEB`  |
> | `bg-green-50`    | `#F0FDF4`                 | `#ECFDF5`  |
> | `text-green-700` | `#15803D`                 | `#047857`  |
>
> `white` は `COLORS.neutral[50]`（`#FAF9F7`）が暖色寄りで、`text-white` と並べると
> そこだけ黄ばんで見えるため、純白を独立したトークンとして持つ。

- [x] **Step 2: theme.ts と tailwind.config.js の同期テストを追加する**

色の二重定義がずれると気づけないため、同期をテストで固定する。

```ts
// apps/mobile/src/constants/theme.test.ts に追記
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tailwindConfig = require('../../tailwind.config.js');

describe('theme.ts と tailwind.config.js の同期', () => {
  // スケール単位ではなく COLORS 全体を比較する。theme.ts に色を足して
  // tailwind.config.js への追記を忘れた場合もこれ 1 本で検知できる
  it('カラートークンが過不足なく一致する', () => {
    expect(tailwindConfig.theme.extend.colors).toEqual(COLORS);
  });

  it('カードの角丸が一致する', () => {
    expect(tailwindConfig.theme.extend.borderRadius.card).toBe(`${RADIUS.card}px`);
  });

  // 期待値を定数から導出する。Tailwind 側にキーの過不足があっても検知できる
  const toPixels = (values: Readonly<Record<string, number>>): Record<string, string> =>
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, `${value}px`]));

  it('フォントサイズの全キーが一致する', () => {
    expect(tailwindConfig.theme.extend.fontSize).toEqual(toPixels(FONT_SIZES));
  });

  it('余白の全キーが一致する', () => {
    expect(tailwindConfig.theme.extend.spacing).toEqual(toPixels(SPACING));
  });

  it('重なり順の全キーが一致する', () => {
    const expectedZIndex = Object.fromEntries(
      Object.entries(Z_INDEX).map(([key, value]) => [key, String(value)]),
    );
    expect(tailwindConfig.theme.extend.zIndex).toEqual(expectedZIndex);
  });
});
```

`toEqual` でオブジェクト全体を比較しているため、片側にキーを足し忘れた場合も落ちる。

- [x] **Step 3: テストが通ることを確認する**

Run: `npm test -w @meshimap/mobile -- theme`
Expected: PASS（11 件）

わざと `tailwind.config.js` の `primary.500` を `#FF0000` に変えて**テストが失敗すること**
（`primary の全スケールが一致する` が FAIL）を確認し、元に戻す。
同様に `fontSize.base` を `'16px'` に変えて `フォントサイズの全キーが一致する` が FAIL することも
確認する。これで同期テストが実際に機能していることが分かる。

生成 CSS でも裏取りできる:
`npx tailwindcss -c tailwind.config.js -i ./src/global.css -o /tmp/out.css` を実行し、
`.text-base { font-size: 15px }` `.p-md { padding: 16px }` `.z-bottomSheet { z-index: 30 }`
が出力されることを確認する（クラスを使っているファイルが content に必要なので、
一時的にクラスを並べた tsx を置いてから実行する）。

- [x] **Step 4: コミットする**

```bash
git add apps/mobile/tailwind.config.js apps/mobile/src/constants/theme.test.ts
git commit -m "feat(mobile): Tailwind にテーマ値を反映し同期テストを追加する"
```

---

### Task 0-4: Google Fonts を読み込む

**Files:**

- Create: `apps/mobile/src/constants/fonts.ts`
- Create: `apps/mobile/src/hooks/use-app-fonts.ts`
- Modify: `apps/mobile/src/app/_layout.tsx`

**Interfaces:**

- Consumes: `expo-font`, `@expo-google-fonts/outfit`, `@expo-google-fonts/noto-sans-jp`
- Produces: `useAppFonts(): { areFontsLoaded: boolean }`、フォント名定数 `FONT_FAMILIES`

- [x] **Step 1: フォント名定数を作る**

```ts
// apps/mobile/src/constants/fonts.ts

/**
 * フォント名。tailwind.config.js の fontFamily と一致させること。
 * 英数字・数値は Outfit（評価点や価格が締まる）、日本語本文は Noto Sans JP。
 */
export const FONT_FAMILIES = {
  displaySemiBold: 'Outfit_600SemiBold',
  displayBold: 'Outfit_700Bold',
  bodyRegular: 'NotoSansJP_400Regular',
  bodyMedium: 'NotoSansJP_500Medium',
  bodyBold: 'NotoSansJP_700Bold',
} as const;
```

- [x] **Step 2: フォント読み込みフックを作る**

```ts
// apps/mobile/src/hooks/use-app-fonts.ts
import {
  NotoSansJP_400Regular,
  NotoSansJP_500Medium,
  NotoSansJP_700Bold,
} from '@expo-google-fonts/noto-sans-jp';
import { Outfit_600SemiBold, Outfit_700Bold } from '@expo-google-fonts/outfit';
import { useFonts } from 'expo-font';

/** アプリ全体で使うフォントを読み込む。読み込み完了までスプラッシュを維持する */
export function useAppFonts(): { areFontsLoaded: boolean } {
  const [areFontsLoaded] = useFonts({
    Outfit_600SemiBold,
    Outfit_700Bold,
    NotoSansJP_400Regular,
    NotoSansJP_500Medium,
    NotoSansJP_700Bold,
  });

  return { areFontsLoaded };
}
```

- [x] **Step 3: \_layout.tsx でフォント読み込みを待つ**

```tsx
// apps/mobile/src/app/_layout.tsx
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { useAppFonts } from '@/hooks/use-app-fonts';
import '../global.css';

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const { areFontsLoaded } = useAppFonts();

  useEffect(() => {
    // フォント未読込のまま表示すると文字がちらつくため、読み込み完了までスプラッシュを維持する
    if (areFontsLoaded) {
      void SplashScreen.hideAsync();
    }
  }, [areFontsLoaded]);

  if (!areFontsLoaded) {
    return null;
  }

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack screenOptions={{ headerShown: false }} />
    </ThemeProvider>
  );
}
```

注意: `import '../global.css'` を忘れると NativeWind のスタイルが適用されない。

- [x] **Step 4: 起動して日本語が Noto Sans JP で表示されることを確認する**

Run: `npm run mobile`
確認: 画面のテキストに `className="font-body"` を一時的に付け、
システムフォントとの差（字形・行間）が目視で分かること。

- [x] **Step 5: コミットする**

```bash
git add apps/mobile/src/constants/fonts.ts apps/mobile/src/hooks/use-app-fonts.ts apps/mobile/src/app/_layout.tsx
git commit -m "feat(mobile): Outfit と Noto Sans JP を読み込む"
```

---

### Task 0-5: ロガーを作る

**Files:**

- Create: `apps/mobile/src/lib/logger.ts`
- Create: `apps/mobile/src/lib/logger.test.ts`

**Interfaces:**

- Produces: `logger.debug/info/warn/error(message: string, context?: Record<string, unknown>): void`

- [x] **Step 1: 失敗するテストを書く**

```ts
// apps/mobile/src/lib/logger.test.ts
import { createLogger } from './logger';

describe('createLogger', () => {
  it('開発時は debug を出力する', () => {
    const sink = jest.fn();
    const logger = createLogger({ isDevelopment: true, sink });

    logger.debug('地図を再検索する', { radiusM: 1000 });

    expect(sink).toHaveBeenCalledWith('debug', '地図を再検索する', { radiusM: 1000 });
  });

  it('本番では debug を出力しない', () => {
    const sink = jest.fn();
    const logger = createLogger({ isDevelopment: false, sink });

    logger.debug('地図を再検索する');

    expect(sink).not.toHaveBeenCalled();
  });

  it('本番でも error は出力する', () => {
    const sink = jest.fn();
    const logger = createLogger({ isDevelopment: false, sink });

    logger.error('店舗の取得に失敗した', { shopId: 'shp_1' });

    expect(sink).toHaveBeenCalledWith('error', '店舗の取得に失敗した', { shopId: 'shp_1' });
  });
});
```

- [x] **Step 2: テストが失敗することを確認する**

Run: `npm test -w @meshimap/mobile -- logger`
Expected: FAIL（`Cannot find module './logger'`）

- [x] **Step 3: logger.ts を実装する**

```ts
// apps/mobile/src/lib/logger.ts

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogSink = (level: LogLevel, message: string, context?: Record<string, unknown>) => void;

export interface Logger {
  debug: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
}

interface CreateLoggerOptions {
  isDevelopment: boolean;
  sink: LogSink;
}

/** 本番で出力するレベル。debug と info は開発時のみ */
const PRODUCTION_LEVELS: readonly LogLevel[] = ['warn', 'error'];

export function createLogger({ isDevelopment, sink }: CreateLoggerOptions): Logger {
  const emit = (level: LogLevel) => (message: string, context?: Record<string, unknown>) => {
    if (!isDevelopment && !PRODUCTION_LEVELS.includes(level)) {
      return;
    }
    sink(level, message, context);
  };

  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  };
}

/* eslint-disable no-console */
const consoleSink: LogSink = (level, message, context) => {
  const payload = context ? [message, context] : [message];
  if (level === 'error') console.error(...payload);
  else if (level === 'warn') console.warn(...payload);
  else console.log(...payload);
};
/* eslint-enable no-console */

/** アプリ全体で使う既定のロガー。コンポーネントからは console を直接呼ばずこれを使う */
export const logger = createLogger({ isDevelopment: __DEV__, sink: consoleSink });
```

- [x] **Step 4: テストが通ることを確認する**

Run: `npm test -w @meshimap/mobile -- logger`
Expected: PASS（3 件）

- [x] **Step 5: コミットする**

```bash
git add apps/mobile/src/lib/logger.ts apps/mobile/src/lib/logger.test.ts
git commit -m "feat(mobile): ロガーを追加する"
```

---

### Task 0-6: Jest 環境を構築する

**Files:**

- Create: `apps/mobile/jest.config.js`
- Create: `apps/mobile/jest-setup.ts`
- Modify: `apps/mobile/package.json`（`jest` フィールドを削除し、設定ファイルへ移す）

**Interfaces:**

- Produces: `npm test -w @meshimap/mobile` が動く環境。RNTL の matcher が使える

- [x] **Step 1: jest.config.js を作る**

```js
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
```

> **なぜ `babel-jest` を `require.resolve` で名指しするのか**
> npm はルートに `@babel/core@8.0.5` を巻き上げる（`@babel/preset-react@8` など v8 の
> プラグイン群が `peerDependencies: @babel/core@^8` を宣言しているため、ルートの
> 巻き上げ先は v8 でなければならない）。一方 `babel-preset-expo@57` は Babel 7 専用で、
> v8 の core から読むと落ちる。`jest-expo` の直下には `@babel/core@7.29.7` が入っているので、
> そこを起点に `babel-jest` を解決させて Babel 7 に寄せる。
> ルート `package.json` に `overrides: { "@babel/core": "7.29.7" }` を書くのは**誤り**で、
> v8 のプラグイン群まで 7 に落としてしまう。narrow にやるなら
> `overrides: { "babel-jest": { "@babel/core": "7.29.7" } }` だが、
> 上記の解決で足りているため依存は増やさない。

> **なぜ transform のキーを 2 本持つのか**
> `jest-expo` プリセットの transform キーは `\.[jt]sx?$` で、`.mjs` / `.cjs` に一致しない。
> `lucide-react-native` は CJS 版も配信しているが、`exports` のキー順で `react-native` 条件が
> `require` より先にあり、そこが `.mjs` を指す。RN の Jest 環境
> （`@react-native/jest-preset/jest/react-native-env.js`）は
> `customExportConditions = ['require', 'react-native']` を設定しており、
> 条件は exports のキー順で評価されるため `.mjs` 側に解決される。
> よってキーを足さないと `Must use import to load ES Module` で落ちる。
> `SOURCE_TRANSFORM_PATTERN` の文字列はプリセットのキーと**完全一致させること**。
> 変えるとプリセット側のキーが生き残り、壊れた `babel-jest` が使われる。

- [x] **Step 2: jest-setup.ts を作る**

```ts
// apps/mobile/jest-setup.ts
import '@testing-library/react-native/extend-expect';

// react-native-reanimated はテスト環境でネイティブモジュールを持たないためモックする
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
```

- [x] **Step 3: package.json から jest フィールドを削除する**

`apps/mobile/package.json` の `"jest": { "preset": "jest-expo" }` を削除する。
設定が 2 箇所にあると、どちらが効いているか分からなくなるため。

- [x] **Step 4: 疎通テストを書いて実行する**

```tsx
// apps/mobile/src/lib/jest-setup.test.tsx
import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

describe('Jest 環境', () => {
  it('React Native コンポーネントをレンダリングできる', () => {
    render(<Text>メシマップ</Text>);
    expect(screen.getByText('メシマップ')).toBeOnTheScreen();
  });
});
```

Run: `npm test -w @meshimap/mobile`
Expected: PASS（logger 3 件 + theme 8 件 + この 1 件）

- [x] **Step 5: コミットする**

```bash
git add apps/mobile/jest.config.js apps/mobile/jest-setup.ts apps/mobile/package.json apps/mobile/src/lib/jest-setup.test.tsx
git commit -m "test(mobile): Jest と React Native Testing Library を構築する"
```

---

### Task 0-7: `Button` プリミティブを作る

**Files:**

- Create: `apps/mobile/src/components/ui/button.tsx`
- Create: `apps/mobile/src/components/ui/button.test.tsx`

**Interfaces:**

- Consumes: `constants/theme.ts`
- Produces:

  ```ts
  type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  type ButtonSize = 'sm' | 'md' | 'lg';
  interface ButtonProps {
    label: string;
    onPress: () => void;
    variant?: ButtonVariant; // 既定 'primary'
    size?: ButtonSize; // 既定 'md'
    isDisabled?: boolean;
    isLoading?: boolean;
    leadingIcon?: ReactNode;
    testID?: string;
  }
  export function Button(props: ButtonProps): JSX.Element;
  ```

- [x] **Step 1: 失敗するテストを書く**

```tsx
// apps/mobile/src/components/ui/button.test.tsx
import { fireEvent, render, screen } from '@testing-library/react-native';

import { Button } from './button';

describe('Button', () => {
  it('ラベルを表示する', () => {
    render(<Button label="予約する" onPress={jest.fn()} />);
    expect(screen.getByText('予約する')).toBeOnTheScreen();
  });

  it('押すと onPress が呼ばれる', () => {
    const onPress = jest.fn();
    render(<Button label="予約する" onPress={onPress} />);

    fireEvent.press(screen.getByRole('button'));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('isDisabled のとき onPress を呼ばない', () => {
    const onPress = jest.fn();
    render(<Button label="予約する" onPress={onPress} isDisabled />);

    fireEvent.press(screen.getByRole('button'));

    expect(onPress).not.toHaveBeenCalled();
  });

  it('isLoading のとき onPress を呼ばない', () => {
    const onPress = jest.fn();
    render(<Button label="予約する" onPress={onPress} isLoading />);

    fireEvent.press(screen.getByRole('button'));

    expect(onPress).not.toHaveBeenCalled();
  });

  it('isLoading のときインジケータを表示する', () => {
    render(<Button label="予約する" onPress={jest.fn()} isLoading testID="reserve-button" />);
    expect(screen.getByTestId('reserve-button-indicator')).toBeOnTheScreen();
  });

  it('isDisabled をアクセシビリティ状態に反映する', () => {
    render(<Button label="予約する" onPress={jest.fn()} isDisabled />);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
```

- [x] **Step 2: テストが失敗することを確認する**

Run: `npm test -w @meshimap/mobile -- button`
Expected: FAIL（`Cannot find module './button'`）

- [x] **Step 3: button.tsx を実装する**

```tsx
// apps/mobile/src/components/ui/button.tsx
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  isDisabled?: boolean;
  isLoading?: boolean;
  leadingIcon?: ReactNode;
  testID?: string;
}

/** variant ごとの見た目。呼び出し側に className を書かせないため、分岐はここに閉じる */
const CONTAINER_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-primary-500 active:bg-primary-600',
  secondary: 'bg-neutral-100 active:bg-neutral-200',
  outline: 'border border-neutral-300 bg-transparent active:bg-neutral-50',
  ghost: 'bg-transparent active:bg-neutral-50',
  danger: 'bg-red-500 active:bg-red-700',
};

const LABEL_STYLES: Record<ButtonVariant, string> = {
  primary: 'text-white',
  secondary: 'text-neutral-800',
  outline: 'text-neutral-800',
  ghost: 'text-primary-600',
  danger: 'text-white',
};

const SIZE_STYLES: Record<ButtonSize, string> = {
  sm: 'px-3 py-2',
  md: 'px-4 py-3',
  lg: 'px-6 py-4',
};

const LABEL_SIZE_STYLES: Record<ButtonSize, string> = {
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-lg',
};

const INDICATOR_COLORS: Record<ButtonVariant, string> = {
  primary: '#FFFFFF',
  secondary: '#2C2823',
  outline: '#2C2823',
  ghost: '#C43F29',
  danger: '#FFFFFF',
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  isDisabled = false,
  isLoading = false,
  leadingIcon,
  testID,
}: ButtonProps) {
  // 読み込み中の多重送信を防ぐため、isLoading も押下不可として扱う
  const isInteractionBlocked = isDisabled || isLoading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isInteractionBlocked, busy: isLoading }}
      disabled={isInteractionBlocked}
      onPress={onPress}
      testID={testID}
      className={[
        'flex-row items-center justify-center gap-2 rounded-card',
        CONTAINER_STYLES[variant],
        SIZE_STYLES[size],
        isInteractionBlocked ? 'opacity-50' : '',
      ].join(' ')}
    >
      {isLoading ? (
        <ActivityIndicator
          color={INDICATOR_COLORS[variant]}
          testID={testID ? `${testID}-indicator` : undefined}
        />
      ) : (
        leadingIcon && <View>{leadingIcon}</View>
      )}
      <Text className={`font-body-medium ${LABEL_STYLES[variant]} ${LABEL_SIZE_STYLES[size]}`}>
        {label}
      </Text>
    </Pressable>
  );
}
```

- [x] **Step 4: テストが通ることを確認する**

Run: `npm test -w @meshimap/mobile -- button`
Expected: PASS（6 件）

- [x] **Step 5: テストが実際に機能していることを確認する**

`isInteractionBlocked` を `isDisabled` だけに書き換え、
「isLoading のとき onPress を呼ばない」が**失敗すること**を確認してから元に戻す。

- [x] **Step 6: コミットする**

```bash
git add apps/mobile/src/components/ui/button.tsx apps/mobile/src/components/ui/button.test.tsx
git commit -m "feat(mobile): Button プリミティブを追加する"
```

---

### Task 0-8 〜 0-13: 残りのプリミティブ

各タスクは Task 0-7 と同じ手順（失敗するテスト → 失敗確認 → 実装 → 通過確認 → 意図的な破壊で検証 → コミット）で進める。
以下は各コンポーネントの **インターフェースと必須テストケース**。

#### Task 0-8: `Card`

**Files:** `components/ui/card.tsx`, `card.test.tsx`

```ts
interface CardProps {
  children: ReactNode;
  onPress?: () => void; // 渡されたときだけ押せる
  padding?: 'none' | 'sm' | 'md'; // 既定 'md'
  testID?: string;
}
```

必須テスト:

- 子要素を表示する
- `onPress` があるとき押下で呼ばれる
- `onPress` がないとき `accessibilityRole` が `button` にならない
- `padding="none"` のとき内側余白のクラスが付かない

#### Task 0-9: `Badge`

**Files:** `components/ui/badge.tsx`, `badge.test.tsx`

```ts
type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'brand';
interface BadgeProps {
  label: string;
  tone?: BadgeTone; // 既定 'neutral'
  leadingIcon?: ReactNode;
  testID?: string;
}
```

必須テスト:

- ラベルを表示する
- tone ごとに異なる背景クラスが付く（5 種すべて）
- `leadingIcon` を渡すと表示される

#### Task 0-10: `Input`

**Files:** `components/ui/input.tsx`, `input.test.tsx`

```ts
interface InputProps {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  errorMessage?: string;
  isRequired?: boolean;
  isMultiline?: boolean;
  maxLength?: number;
  testID?: string;
}
```

必須テスト:

- ラベルを表示する
- 入力すると `onChangeText` が入力値付きで呼ばれる
- `errorMessage` があるときメッセージを表示する
- `errorMessage` があるとき枠線が danger 色になる
- `isRequired` のとき必須マークを表示する
- `maxLength` を指定すると文字数カウンタを表示する
- `isMultiline` の最小高さは className の `h-[96px]` ではなく
  `style={{ minHeight: MULTILINE_MIN_HEIGHT_PX }}` で与える（値の二重管理を避ける）
- アクセシビリティ: エラー時にラベル・必須・エラー文を合成した `accessibilityLabel` が付く
- アクセシビリティ: エラーメッセージが `accessibilityRole="alert"` で公開される

> **`accessibilityInvalid` は使えない（実装時に判明）**
> React Native 0.86.3 の `AccessibilityProps` に `accessibilityInvalid` も `aria-invalid` も存在しない
> （`node_modules/react-native/Libraries/Components/View/ViewAccessibility.d.ts`。
> `AccessibilityState` のキーは `disabled` / `selected` / `checked` / `busy` / `expanded` の 5 つだけ）。
> `grep -rn "accessibilityInvalid" node_modules/react-native/` は 0 件、
> `aria-invalid` も `Libraries` 配下に 0 件（対照として `'aria-busy'` は 16 件ヒットする）。
> よってエラー状態は **`accessibilityLabel` への合成**（例: `店名、必須、エラー: 店名を入力してください`）と
> **エラー文への `accessibilityRole="alert"`** の 2 段構えで伝える。

#### Task 0-11: `Skeleton`

**Files:** `components/ui/skeleton.tsx`, `skeleton.test.tsx`

```ts
interface SkeletonProps {
  width?: number | `${number}%`;
  height: number;
  shape?: 'rect' | 'circle' | 'text'; // 既定 'rect'
  testID?: string;
}
```

必須テスト:

- 指定した高さが反映される
- `shape="circle"` のとき角丸が pill になる
- `shape="text"` のとき既定の高さより低い行状になる

#### Task 0-12: `EmptyState` と `ErrorState`

**Files:** `components/ui/empty-state.tsx`, `error-state.tsx`, それぞれのテスト

```ts
interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: { label: string; onPress: () => void };
  testID?: string;
}

interface ErrorStateProps {
  title?: string; // 既定 'エラーが発生しました'
  description?: string;
  onRetry: () => void;
  testID?: string;
}
```

必須テスト（EmptyState）:

- タイトルを表示する
- `description` があれば表示、なければ表示しない
- `action` があればボタンを表示し、押下でコールバックが呼ばれる

必須テスト（ErrorState）:

- 既定のタイトルを表示する
- 「再試行」ボタン押下で `onRetry` が呼ばれる

#### Task 0-13: `Icon` ラッパ

**Files:** `components/ui/icon.tsx`, `icon.test.tsx`

lucide のアイコンはサイズと色を毎回指定する必要がある。テーマに沿った既定値を持つラッパを作る。

```ts
type IconSize = 'sm' | 'md' | 'lg'; // 16 / 20 / 24 px
interface IconProps {
  icon: LucideIcon;
  size?: IconSize; // 既定 'md'
  color?: string; // 既定 neutral-700
  testID?: string;
}
```

必須テスト:

- 渡したアイコンをレンダリングする
- `size="sm"` のとき 16px が渡る
- `size="lg"` のとき 24px が渡る
- `color` 未指定のとき neutral-700 が渡る

---

### Task 0-14: プリミティブのカタログ画面を作る

**Files:**

- Create: `apps/mobile/src/app/_dev/catalog.tsx`
- Test: `apps/mobile/src/app/_dev/catalog.test.tsx`

**Interfaces:**

- Consumes: Task 0-7〜0-13 の全プリミティブ

> **`_dev/` はルートとして拾われる（`_layout` のような除外はされない）**
> expo-router 57 のファイル探索は `require.context` の正規表現
> `/^(?:\.\/)(?!(?:(?:(?:.*\+api)|(?:\+html)|(?:\+middleware)))\.[tj]sx?$).*\.[tj]sx?$/` で行われ、
> `_` プレフィックスによる一般的な除外は無い（特別扱いされるのは**ファイル名が完全一致で
> `_layout` の場合だけ**）。実測でも `./_dev/catalog.tsx` はこの正規表現に一致する。
> つまりカタログは `/_dev/catalog` で到達でき、本番バンドルにも含まれる。
> ポートフォリオでは「デザインシステムを見せられる」利点の方が大きいため、あえて除外しない。

> **カタログにもテストを置く理由**
> ここは全プリミティブを同時に描画する唯一の場所なので、どれか 1 つが
> 例外を投げるようになった変更を最も早く検知できる。目視確認だけに頼らない。

- [x] **Step 1: 失敗するスモークテストを書く**

```tsx
// apps/mobile/src/app/_dev/catalog.test.tsx
import { render, screen } from '@testing-library/react-native';

import CatalogScreen from './catalog';

/** 画面に必ず並ぶセクション見出し。プリミティブを足したらここにも足す */
const EXPECTED_SECTION_TITLES = [
  'Button',
  'Badge',
  'Card',
  'Input',
  'Skeleton',
  'Icon',
  'EmptyState',
  'ErrorState',
];

describe('CatalogScreen', () => {
  it('全プリミティブのセクションが例外なく描画される', async () => {
    await render(<CatalogScreen />);

    for (const title of EXPECTED_SECTION_TITLES) {
      expect(screen.getByText(title)).toBeTruthy();
    }
  });
});
```

- [x] **Step 2: テストが失敗することを確認する**

Run: `npx jest src/app/_dev/catalog.test.tsx`
Expected: FAIL（`Cannot find module './catalog'`）

- [x] **Step 3: カタログ画面を作る**

全プリミティブを variant / size / 状態ごとに並べる。デザインの一貫性を目視確認する場所であり、
新しいプリミティブを足したらここにも追加する。

```tsx
// apps/mobile/src/app/_dev/catalog.tsx
import { MapPin, Star } from 'lucide-react-native';
import { ScrollView, Text, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

const BUTTON_VARIANTS = ['primary', 'secondary', 'outline', 'ghost', 'danger'] as const;
const BADGE_TONES = ['neutral', 'success', 'warning', 'danger', 'brand'] as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="gap-sm border-b border-neutral-200 py-lg">
      <Text className="font-display text-lg text-neutral-900">{title}</Text>
      {children}
    </View>
  );
}

export default function CatalogScreen() {
  return (
    <ScrollView className="flex-1 bg-white px-md">
      <Section title="Button">
        {BUTTON_VARIANTS.map((variant) => (
          <Button key={variant} label={variant} variant={variant} onPress={() => {}} />
        ))}
        <Button label="読み込み中" onPress={() => {}} isLoading />
        <Button label="無効" onPress={() => {}} isDisabled />
      </Section>

      <Section title="Badge">
        <View className="flex-row flex-wrap gap-sm">
          {BADGE_TONES.map((tone) => (
            <Badge key={tone} label={tone} tone={tone} />
          ))}
        </View>
      </Section>

      <Section title="Card">
        <Card>
          <Text className="font-body text-neutral-800">押せないカード</Text>
        </Card>
        <Card onPress={() => {}}>
          <Text className="font-body text-neutral-800">押せるカード</Text>
        </Card>
      </Section>

      <Section title="Input">
        <Input
          label="店名"
          value=""
          onChangeText={() => {}}
          placeholder="例: 炭火焼鳥 とり源"
          isRequired
        />
        <Input
          label="電話番号"
          value="03-"
          onChangeText={() => {}}
          errorMessage="電話番号の形式が正しくありません"
        />
      </Section>

      <Section title="Skeleton">
        <Skeleton height={160} />
        <Skeleton height={16} shape="text" width="60%" />
        <Skeleton height={48} width={48} shape="circle" />
      </Section>

      <Section title="Icon">
        <View className="flex-row items-center gap-sm">
          <Icon icon={MapPin} size="sm" />
          <Icon icon={MapPin} size="md" />
          <Icon icon={Star} size="lg" />
        </View>
      </Section>

      <Section title="EmptyState">
        <EmptyState
          icon={MapPin}
          title="この条件のお店は見つかりませんでした"
          description="範囲を広げるか、条件を減らしてみてください。"
          action={{ label: '条件をリセット', onPress: () => {} }}
        />
      </Section>

      <Section title="ErrorState">
        <ErrorState onRetry={() => {}} />
      </Section>
    </ScrollView>
  );
}
```

- [x] **Step 4: テストが通ることを確認する**

Run: `npx jest src/app/_dev/catalog.test.tsx`
Expected: PASS

- [x] **Step 5: わざと壊してテストが落ちることを確認する**

`EXPECTED_SECTION_TITLES` のどれか 1 つに対応する `<Section>` を一時的に削除し、
テストが `Unable to find an element with text:` で落ちることを確認してから元に戻す。

- [x] **Step 6: 起動して全プリミティブが表示されることを確認する**

Run: `npm run mobile` → `/_dev/catalog` へ遷移
確認: すべての variant が崩れず表示され、フォントがテーマどおりであること。

- [x] **Step 7: 全テストが通ることを確認する**

Run: `npm test -w @meshimap/mobile`
Expected: Phase 0 で書いた全テストが PASS

- [x] **Step 8: 型チェックが通ることを確認する**

Run: `npm run typecheck -w @meshimap/mobile`
Expected: エラーなし

- [x] **Step 9: コミットする**

```bash
git add apps/mobile/src/app/_dev/catalog.tsx apps/mobile/src/app/_dev/catalog.test.tsx
git commit -m "feat(mobile): UI プリミティブのカタログ画面を追加する"
```

---

## Phase 0 完了条件

> **進捗の記録方法について。** チェックボックスは実装完了後にまとめて付けた。実測で確認した根拠は次のとおり（2026-09-15 時点）: `npm test -w @meshimap/mobile` = 15 スイート / 105 件 PASS、`npm run typecheck -w @meshimap/mobile` エラーなし、`apps/mobile/src/app/_dev/catalog.tsx` と `catalog.test.tsx` が存在、`apps/mobile/src/constants/theme.test.ts` が theme.ts と tailwind.config.js の同期を検証、`console.log` は `src/` 配下に 0 件。

- [x] `npm test -w @meshimap/mobile` が全件 PASS
- [x] `npm run typecheck -w @meshimap/mobile` がエラーなし
- [x] `/_dev/catalog` で 8 種のプリミティブが意図どおり表示される
- [x] `theme.ts` と `tailwind.config.js` の同期テストが機能している（わざと壊して確認済み）
- [x] `console.log` がコードベースに 1 つもない（`logger.ts` の sink を除く）
