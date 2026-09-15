/**
 * フォント名。tailwind.config.js の fontFamily と一致させること（fonts.test.ts で同期を検証する）。
 * 英数字・数値は Outfit（評価点や価格が締まる）、日本語本文は Noto Sans JP。
 */
export const FONT_FAMILIES = {
  displaySemiBold: 'Outfit_600SemiBold',
  displayBold: 'Outfit_700Bold',
  bodyRegular: 'NotoSansJP_400Regular',
  bodyMedium: 'NotoSansJP_500Medium',
  bodyBold: 'NotoSansJP_700Bold',
} as const;
