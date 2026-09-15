import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'brand';

export interface BadgeProps {
  label: string;
  tone?: BadgeTone | undefined;
  leadingIcon?: ReactNode | undefined;
  testID?: string | undefined;
}

/**
 * tone ごとの背景色。呼び出し側に className を書かせないため、分岐はここに閉じる。
 * 「営業中/準備中」のような状態表示に使うので、地の色より濃くしすぎない 50〜100 番台にする。
 */
const CONTAINER_STYLES: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-100',
  success: 'bg-green-50',
  warning: 'bg-amber-50',
  danger: 'bg-red-50',
  brand: 'bg-primary-50',
};

/** 背景が淡いぶん、文字は同系色の 700 番台にしてコントラストを確保する */
const LABEL_STYLES: Record<BadgeTone, string> = {
  neutral: 'text-neutral-700',
  success: 'text-green-700',
  warning: 'text-amber-700',
  danger: 'text-red-700',
  brand: 'text-primary-700',
};

export function Badge({ label, tone = 'neutral', leadingIcon, testID }: BadgeProps) {
  return (
    <View
      className={`flex-row items-center gap-xs self-start rounded-full px-sm py-xs ${CONTAINER_STYLES[tone]}`}
      testID={testID}
    >
      {leadingIcon ? (
        <View testID={testID === undefined ? undefined : `${testID}-leading-icon`}>
          {leadingIcon}
        </View>
      ) : null}
      <Text className={`font-body-medium text-xs ${LABEL_STYLES[tone]}`}>{label}</Text>
    </View>
  );
}
