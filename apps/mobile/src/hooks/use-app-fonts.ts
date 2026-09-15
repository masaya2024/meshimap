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
