import { FONT_FAMILIES } from './fonts';

/** 同期検証で参照する tailwind.config.js の形。設定全体ではなく検証対象だけを型にする */
interface TailwindFontConfig {
  theme: {
    extend: {
      fontFamily: Record<string, readonly string[]>;
    };
  };
}

// tailwind.config.js は CommonJS のため import ではなく require で読み込む
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tailwindConfig: TailwindFontConfig = require('../../tailwind.config.js');

describe('FONT_FAMILIES', () => {
  it('英数字は Outfit、日本語本文は Noto Sans JP を指す', () => {
    expect(FONT_FAMILIES.displaySemiBold).toBe('Outfit_600SemiBold');
    expect(FONT_FAMILIES.bodyRegular).toBe('NotoSansJP_400Regular');
  });

  it('tailwind.config.js の fontFamily と同じフォント名の集合を指す', () => {
    const tailwindFontNames = Object.values(tailwindConfig.theme.extend.fontFamily).flat().sort();

    expect(tailwindFontNames).toEqual([...Object.values(FONT_FAMILIES)].sort());
  });
});
