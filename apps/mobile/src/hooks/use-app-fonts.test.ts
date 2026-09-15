import { renderHook } from '@testing-library/react-native';
import type { FontSource } from 'expo-font';
import { useFonts } from 'expo-font';

import { FONT_FAMILIES } from '@/constants/fonts';

import { useAppFonts } from './use-app-fonts';

// expo-font の useFonts はネイティブのフォント読み込みを伴い、テスト環境では常に未完了のままになる。
// 読み込み状態を任意に作り、渡されたフォントマップを検査したいのでモジュールごと差し替える
jest.mock('expo-font', () => ({ useFonts: jest.fn() }));

const useFontsMock = jest.mocked(useFonts);

/**
 * 読み込むべきフォント名。use-app-fonts.ts と fonts.ts のどちらか片方だけ増減したときに
 * 落ちるよう、どちらからも導出せず直値で持つ。
 */
const EXPECTED_FONT_FAMILIES = [
  'Outfit_600SemiBold',
  'Outfit_700Bold',
  'NotoSansJP_400Regular',
  'NotoSansJP_500Medium',
  'NotoSansJP_700Bold',
];

/** useFonts に渡された引数のうち、フォントマップ側の型 */
type FontMap = Record<string, FontSource>;

/** useFonts へ実際に渡されたフォントマップを取り出す */
function getLoadedFontMap(): FontMap {
  const [firstCall] = useFontsMock.mock.calls;
  if (firstCall === undefined) {
    throw new Error('useFonts が呼ばれていない');
  }

  const [fontMap] = firstCall;
  if (typeof fontMap === 'string') {
    throw new Error('useFonts には単一フォント名ではなくフォントマップを渡すこと');
  }

  return fontMap;
}

/** 指定した読み込み状態でフックを描画する。RNTL 14 の renderHook は async */
async function renderAppFonts(isLoaded: boolean) {
  useFontsMock.mockReturnValue([isLoaded, null]);
  const { result } = await renderHook(() => useAppFonts());
  return result;
}

describe('useAppFonts', () => {
  beforeEach(() => {
    useFontsMock.mockReset();
  });

  it('読み込み中は areFontsLoaded が false', async () => {
    const result = await renderAppFonts(false);

    expect(result.current.areFontsLoaded).toBe(false);
  });

  it('読み込みが終わると areFontsLoaded が true', async () => {
    const result = await renderAppFonts(true);

    expect(result.current.areFontsLoaded).toBe(true);
  });

  it('useFonts に 5 種すべてのフォント名を渡す', async () => {
    await renderAppFonts(true);

    expect(Object.keys(getLoadedFontMap()).sort()).toEqual([...EXPECTED_FONT_FAMILIES].sort());
  });

  it('読み込むフォント名は FONT_FAMILIES と一致する', () => {
    // 読み込み対象と、スタイル側が参照する名前がずれると
    // 「クラスは当たっているのにフォントだけ既定のまま」になり、見た目でしか気づけない
    expect([...Object.values(FONT_FAMILIES)].sort()).toEqual([...EXPECTED_FONT_FAMILIES].sort());
  });

  it('渡すフォントの実体がすべて解決されている', async () => {
    await renderAppFonts(true);

    // import 名を間違えると undefined が渡るが、キー名だけの検証では通ってしまう
    const unresolvedFamilies = Object.entries(getLoadedFontMap())
      .filter(([, source]) => source === undefined || source === null)
      .map(([family]) => family);

    expect(unresolvedFamilies).toEqual([]);
  });
});
