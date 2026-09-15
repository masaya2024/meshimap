import { View } from 'react-native';

import { RADIUS } from '@/constants/theme';

export type SkeletonShape = 'rect' | 'circle' | 'text';

export interface SkeletonProps {
  width?: number | `${number}%` | undefined;
  height: number;
  shape?: SkeletonShape | undefined;
  testID?: string | undefined;
}

/**
 * 幅を省略したときの既定値。リスト行のプレースホルダが最も多い用途で、
 * その場合は親の幅いっぱいに伸ばすのが自然なため。
 */
const DEFAULT_WIDTH = '100%';

/**
 * shape ごとの角丸。rect はカード内の小要素、text は文字行、circle はアバターを想定する。
 * 角丸は寸法と同じく動的に決まるので className ではなく style で渡す（下の STYLE の注記も参照）。
 */
const SHAPE_RADIUS: Record<SkeletonShape, number> = {
  rect: RADIUS.md,
  circle: RADIUS.pill,
  text: RADIUS.sm,
};

/**
 * shape="text" のバー高さの比率。
 * height は「文字行のボックス高さ（=lineHeight 相当）」として受け取る想定だが、
 * ボックスいっぱいに塗ると実際の文字列より明らかに太く見えて行に見えない。
 * 和文フォントの字面はボックスのおよそ 7 割なので、そこに合わせて細くする。
 */
const TEXT_LINE_HEIGHT_RATIO = 0.7;

export function Skeleton({ width, height, shape = 'rect', testID }: SkeletonProps) {
  // 円は縦横が等しくないと崩れるため、幅未指定のときは height を直径として使う
  const resolvedWidth = width ?? (shape === 'circle' ? height : DEFAULT_WIDTH);
  const resolvedHeight = shape === 'text' ? Math.round(height * TEXT_LINE_HEIGHT_RATIO) : height;

  return (
    <View
      testID={testID}
      className="bg-neutral-200"
      // 寸法と角丸は props で決まる動的な値なので、Tailwind のクラスではなく style で渡す
      style={{ width: resolvedWidth, height: resolvedHeight, borderRadius: SHAPE_RADIUS[shape] }}
    />
  );
}
