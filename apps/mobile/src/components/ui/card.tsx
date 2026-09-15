import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

export type CardPadding = 'none' | 'sm' | 'md';

export interface CardProps {
  children: ReactNode;
  onPress?: (() => void) | undefined;
  padding?: CardPadding | undefined;
  testID?: string | undefined;
}

/**
 * 全カード共通の見た目。画面の地色が neutral-50 なので、面を持ち上げるために純白を敷く。
 * 呼び出し側に className を書かせないため、分岐はこのファイルに閉じる。
 */
const CONTAINER_STYLES = 'rounded-card border border-neutral-200 bg-white';

/** 写真を端まで見せたいカードがあるため none を用意する */
const PADDING_STYLES: Record<CardPadding, string> = {
  none: '',
  sm: 'p-sm',
  md: 'p-md',
};

export function Card({ children, onPress, padding = 'md', testID }: CardProps) {
  const className = [CONTAINER_STYLES, PADDING_STYLES[padding]]
    .filter((style) => style !== '')
    .join(' ');

  // onPress が無いカードはただの面。button ロールを付けるとスクリーンリーダーが
  // 押せると読み上げてしまうため、Pressable ごと使わない
  if (onPress === undefined) {
    return (
      <View className={className} testID={testID}>
        {children}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      className={`${className} active:bg-neutral-50`}
      onPress={onPress}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}
