import type { LucideIcon } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { COLORS } from '@/constants/theme';

import { Button, type ButtonSize, type ButtonVariant } from './button';

export interface EmptyStateAction {
  label: string;
  onPress: () => void;
  /** 前提条件が揃うまで押させたくないとき（例: 位置情報が未許可）に立てる */
  isDisabled?: boolean | undefined;
  /** 再取得中など、押下結果を待っている間に立てる。多重送信も Button 側で止まる */
  isLoading?: boolean | undefined;
}

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string | undefined;
  action?: EmptyStateAction | undefined;
  testID?: string | undefined;
}

/**
 * 空状態の主役となるアイコンの大きさ。
 * Icon プリミティブの最大 24px は本文に添える用途の寸法で、画面中央に単独で置くには小さすぎる。
 */
const HERO_ICON_PIXEL_SIZE = 48;

/** ヒーローアイコンの色。文言より目立たせないため本文より薄い neutral-400 にする */
const HERO_ICON_COLOR = COLORS.neutral[400];

/**
 * アクションボタンの variant。
 * 空状態のアクションは画面内で唯一の行動導線であり、ユーザーを次の行動へ押し出すのが役目なので主役色の primary を選ぶ。
 * secondary / outline / ghost は「他に主導線がある中での補助操作」を表す見た目で、唯一の導線に使うと見落とされる。
 */
const ACTION_BUTTON_VARIANT: ButtonVariant = 'primary';

/**
 * アクションボタンの size。
 * 置き換え前の手書き実装が px-4 py-3 で、Button の md がこれと同値なので見た目の回帰が起きない。
 * lg は画面中央で主張が過剰になり、sm は単独配置のタップ対象としては小さい。
 */
const ACTION_BUTTON_SIZE: ButtonSize = 'md';

/** 呼び出し側とテストが依存しているアクションボタンの testID 接尾辞。変えると参照が壊れる */
const ACTION_BUTTON_TEST_ID_SUFFIX = '-action-button';

/**
 * 読み上げラベルでタイトルと説明をつなぐ文字。
 * 単純に連結すると一続きの文として読み上げられてしまうため、句点で間を持たせる。
 */
const ACCESSIBILITY_LABEL_SEPARATOR = '。';

export function EmptyState({
  icon: IconComponent,
  title,
  description,
  action,
  testID,
}: EmptyStateProps) {
  // タイトルと説明が別々の読み上げ要素だと、スクリーンリーダーでは「何が起きたか」と
  // 「どうすればよいか」がスワイプ 2 回に分断されて伝わる。1 つのラベルにまとめて一度で状況を伝える。
  const announcementLabel =
    description === undefined ? title : `${title}${ACCESSIBILITY_LABEL_SEPARATOR}${description}`;

  return (
    <View className="items-center justify-center gap-sm px-lg py-xl" testID={testID}>
      <IconComponent size={HERO_ICON_PIXEL_SIZE} color={HERO_ICON_COLOR} />

      {/*
        accessible でタイトルと説明をひとまとまりの読み上げ単位にする。
        role は「操作できない状況説明」なので text。alert は緊急通知の扱いになり、
        検索結果 0 件のような通常の結果には強すぎる。
        accessibilityLiveRegion は RN 0.86.3 では Android 専用（型定義にも @platform android と明記）。
        検索結果が 0 件になった瞬間など、フォーカスを奪わずに状況を知らせたいので polite を使う。
        gap / items-center は、この View を挟んだことで元の余白と中央揃えが崩れないよう元の値を引き継ぐ。
      */}
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={announcementLabel}
        accessibilityLiveRegion="polite"
        className="items-center gap-sm"
      >
        <Text className="text-center font-display text-lg text-neutral-900">{title}</Text>

        {description === undefined ? null : (
          <Text className="text-center font-body text-sm text-neutral-600">{description}</Text>
        )}
      </View>

      {action === undefined ? null : (
        // Button は className を受け取らない設計なので、置き換え前の mt-sm による追加余白は外側の View で保つ
        <View className="mt-sm">
          <Button
            label={action.label}
            onPress={action.onPress}
            variant={ACTION_BUTTON_VARIANT}
            size={ACTION_BUTTON_SIZE}
            isDisabled={action.isDisabled}
            isLoading={action.isLoading}
            testID={testID === undefined ? undefined : `${testID}${ACTION_BUTTON_TEST_ID_SUFFIX}`}
          />
        </View>
      )}
    </View>
  );
}
