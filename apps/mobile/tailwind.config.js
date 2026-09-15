/**
 * テーマ値は src/constants/theme.ts と二重管理になる（Tailwind の設定は CommonJS なので
 * TypeScript の theme.ts を直接 import できない）。ずれに気づけるよう
 * src/constants/theme.test.ts で同期をテストしている。
 *
 * @type {import('tailwindcss').Config}
 */
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
        // src/constants/fonts.ts の FONT_FAMILIES と一致させること
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
      // 重なり順は用途名で指定する（z-30 ではなく z-bottom-sheet のように書けないため
      // キー名は theme.ts と同じ camelCase を使い z-bottomSheet として参照する）
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
