import { TriangleAlert } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { SEMANTIC_COLORS } from '@/constants/theme';

import { Button } from './button';
import { Icon } from './icon';

export interface ErrorStateProps {
  title?: string | undefined;
  description?: string | undefined;
  onRetry: () => void;
  testID?: string | undefined;
}

/** 原因を特定できない失敗の総称。呼び出し側が毎回同じ文言を書かなくて済むよう既定値にする */
const DEFAULT_TITLE = 'エラーが発生しました';

/** 再試行ボタンの文言。文言を変える必要が出たときに 1 箇所で直せるよう定数にする */
const RETRY_LABEL = '再試行';

/**
 * 警告アイコンの色。SEMANTIC_COLORS.danger（= red[500]）を選ぶ。
 * primary はブランド色で「押せる」印象を持たせている色なので、
 * 押せない状態表示に使うと再試行ボタンと視覚的に競合する。
 * danger は theme.ts で「失敗・異常」の意味に割り当てられており、
 * 赤の使いどころがこのコンポーネント固有の判断にならない点でも妥当と判断した。
 */
const ICON_COLOR = SEMANTIC_COLORS.danger;

/** 子要素の testID サフィックス。テスト側と綴りがずれないよう定数にする */
const ICON_TEST_ID_SUFFIX = 'icon';
const RETRY_BUTTON_TEST_ID_SUFFIX = 'retry-button';

/**
 * 親が testID を持たないときは子にも付けない。
 * `${undefined}-icon` のような文字列を誤って生成させないためのヘルパ。
 */
function buildChildTestId(testID: string | undefined, suffix: string): string | undefined {
  return testID === undefined ? undefined : `${testID}-${suffix}`;
}

export function ErrorState({
  title = DEFAULT_TITLE,
  description,
  onRetry,
  testID,
}: ErrorStateProps) {
  return (
    <View className="items-center justify-center gap-sm px-lg py-xl" testID={testID}>
      <Icon
        icon={TriangleAlert}
        size="lg"
        color={ICON_COLOR}
        testID={buildChildTestId(testID, ICON_TEST_ID_SUFFIX)}
      />

      <Text className="text-center font-display text-lg text-neutral-900">{title}</Text>

      {description === undefined ? null : (
        <Text className="text-center font-body text-sm text-neutral-600">{description}</Text>
      )}

      {/*
        Button は className を受け取らないので、タイトル群と再試行ボタンの間隔を広げる
        mt-sm はラッパの View 側で持つ。Pressable で組んでいた頃の見た目を保つための余白。
      */}
      <View className="mt-sm">
        {/*
          variant は primary。再試行はユーザーに取ってほしい主要アクションであり、
          danger は「押すと壊れる」操作に予約したい。もとの手書きボタンも
          bg-primary-500 / active:bg-primary-600 だったので見た目も変わらない。
        */}
        <Button
          label={RETRY_LABEL}
          onPress={onRetry}
          variant="primary"
          testID={buildChildTestId(testID, RETRY_BUTTON_TEST_ID_SUFFIX)}
        />
      </View>
    </View>
  );
}
