import type { LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';

import { COLORS } from '@/constants/theme';

export type IconSize = 'sm' | 'md' | 'lg';

export interface IconProps {
  icon: LucideIcon;
  size?: IconSize | undefined;
  color?: string | undefined;
  testID?: string | undefined;
}

/**
 * lucide に渡す実ピクセル。サイズを 3 段階に絞ることで、画面ごとに大きさがばらつくのを防ぐ。
 * sm=本文に添えるアイコン、md=既定、lg=見出しやタブバー。
 */
const ICON_PIXEL_SIZES: Record<IconSize, number> = {
  sm: 16,
  md: 20,
  lg: 24,
};

/** 既定色。本文の文字色と同じ neutral-700 にして、テキストと並んだときに浮かないようにする */
const DEFAULT_ICON_COLOR = COLORS.neutral[700];

/**
 * lucide アイコンをアプリ共通のサイズ・色・アクセシビリティ設定で包むラッパ。
 *
 * 注意: スクリーンリーダーから隠しているため、RNTL 14 の既定
 * （`defaultIncludeHiddenElements: false`）ではクエリの対象外になる。
 * テストから取得するときは `getByTestId(id, { includeHiddenElements: true })` を使う。
 */
export function Icon({
  icon: IconComponent,
  size = 'md',
  color = DEFAULT_ICON_COLOR,
  testID,
}: IconProps) {
  const pixelSize = ICON_PIXEL_SIZES[size];

  return (
    <View
      // lucide のアイコンは受け取った testID を Web 用の `data-testid` に変換して
      // react-native-svg へ渡すため、RN のツリー上には testID が現れず getByTestId で拾えない。
      // testID はラッパの View 側に付けることでしか機能させられない。
      testID={testID}
      // アイコンは常にラベル付きのテキストやボタンに添える装飾なので、
      // スクリーンリーダーには読ませない。RN は隠す指定がプラットフォームごとに分かれており、
      // iOS は accessibilityElementsHidden、Android は importantForAccessibility しか見ないため両方必要。
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      // 大きさは ICON_PIXEL_SIZES から実行時に決まるので静的な className では表現できない。
      // ラッパを挟んでもレイアウトが変わらないよう、アイコン本体と同じ実寸を明示する。
      style={{ width: pixelSize, height: pixelSize }}
    >
      <IconComponent size={pixelSize} color={color} />
    </View>
  );
}
