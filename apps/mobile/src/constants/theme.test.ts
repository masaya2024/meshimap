import { COLORS, FONT_SIZES, RADIUS, SEMANTIC_COLORS, SPACING, Z_INDEX } from './theme';

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

/** 同期検証で参照する tailwind.config.js の形。設定全体ではなく検証対象だけを型にする */
interface TailwindThemeConfig {
  theme: {
    extend: {
      colors: Record<string, Record<string, string> | string>;
      borderRadius: Record<string, string>;
      fontFamily: Record<string, readonly string[]>;
      fontSize: Record<string, string>;
      spacing: Record<string, string>;
      zIndex: Record<string, string>;
    };
  };
}

// tailwind.config.js は CommonJS のため import ではなく require で読み込む
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tailwindConfig: TailwindThemeConfig = require('../../tailwind.config.js');

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
