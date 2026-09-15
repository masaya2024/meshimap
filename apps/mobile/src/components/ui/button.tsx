import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { COLORS } from '@/constants/theme';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  isDisabled?: boolean | undefined;
  isLoading?: boolean | undefined;
  leadingIcon?: ReactNode | undefined;
  testID?: string | undefined;
}

/** variant ごとの見た目。呼び出し側に className を書かせないため、分岐はここに閉じる */
const CONTAINER_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-primary-500 active:bg-primary-600',
  secondary: 'bg-neutral-100 active:bg-neutral-200',
  outline: 'border border-neutral-300 bg-transparent active:bg-neutral-50',
  ghost: 'bg-transparent active:bg-neutral-50',
  danger: 'bg-red-500 active:bg-red-700',
};

const LABEL_STYLES: Record<ButtonVariant, string> = {
  primary: 'text-white',
  secondary: 'text-neutral-800',
  outline: 'text-neutral-800',
  ghost: 'text-primary-600',
  danger: 'text-white',
};

const SIZE_STYLES: Record<ButtonSize, string> = {
  sm: 'px-3 py-2',
  md: 'px-4 py-3',
  lg: 'px-6 py-4',
};

const LABEL_SIZE_STYLES: Record<ButtonSize, string> = {
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-lg',
};

/**
 * ActivityIndicator は className で色を指定できないため JS 側で色を渡す。
 * 上の LABEL_STYLES と同じ色になるよう theme.ts の定数から引く。
 */
const INDICATOR_COLORS: Record<ButtonVariant, string> = {
  primary: COLORS.white,
  secondary: COLORS.neutral[800],
  outline: COLORS.neutral[800],
  ghost: COLORS.primary[600],
  danger: COLORS.white,
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  isDisabled = false,
  isLoading = false,
  leadingIcon,
  testID,
}: ButtonProps) {
  // 読み込み中の多重送信を防ぐため、isLoading も押下不可として扱う
  const isInteractionBlocked = isDisabled || isLoading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isInteractionBlocked, busy: isLoading }}
      disabled={isInteractionBlocked}
      onPress={onPress}
      testID={testID}
      className={[
        'flex-row items-center justify-center gap-2 rounded-card',
        CONTAINER_STYLES[variant],
        SIZE_STYLES[size],
        isInteractionBlocked ? 'opacity-50' : '',
      ]
        .filter((className) => className !== '')
        .join(' ')}
    >
      {isLoading ? (
        <ActivityIndicator
          color={INDICATOR_COLORS[variant]}
          testID={testID === undefined ? undefined : `${testID}-indicator`}
        />
      ) : leadingIcon === undefined ? null : (
        <View>{leadingIcon}</View>
      )}
      <Text className={`font-body-medium ${LABEL_STYLES[variant]} ${LABEL_SIZE_STYLES[size]}`}>
        {label}
      </Text>
    </Pressable>
  );
}
