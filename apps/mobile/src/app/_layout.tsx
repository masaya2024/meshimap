import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { useAppFonts } from '@/hooks/use-app-fonts';
// これを忘れると NativeWind のスタイルが一切適用されない
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
