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
