import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { Card } from './card';

/** 内側余白のクラスを直接読むための正規表現。`p-md` などの padding ユーティリティだけに当てる */
const PADDING_CLASS_PATTERN = /(^|\s)p-\S+/;

/**
 * NativeWind はテスト環境では className を style に変換しないため、
 * 付与されたユーティリティクラスは props からそのまま読める。
 */
function getClassName(element: ReturnType<typeof screen.getByTestId>): string {
  const { className } = element.props;
  return typeof className === 'string' ? className : '';
}

// RNTL 14 の render / fireEvent は async。await を忘れると screen が空のままになる
describe('Card', () => {
  it('子要素を表示する', async () => {
    await render(
      <Card>
        <Text>とんかつ まる兵</Text>
      </Card>,
    );

    expect(screen.getByText('とんかつ まる兵')).toBeOnTheScreen();
  });

  it('onPress があるとき押下で呼ばれる', async () => {
    const onPress = jest.fn();
    await render(
      <Card onPress={onPress}>
        <Text>とんかつ まる兵</Text>
      </Card>,
    );

    await fireEvent.press(screen.getByRole('button'));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('onPress があるとき accessibilityRole が button になる', async () => {
    await render(
      <Card onPress={jest.fn()}>
        <Text>とんかつ まる兵</Text>
      </Card>,
    );

    expect(screen.getByRole('button')).toBeOnTheScreen();
  });

  it('onPress がないとき accessibilityRole が button にならない', async () => {
    await render(
      <Card>
        <Text>とんかつ まる兵</Text>
      </Card>,
    );

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('padding="none" のとき内側余白のクラスが付かない', async () => {
    await render(
      <Card padding="none" testID="shop-card">
        <Text>とんかつ まる兵</Text>
      </Card>,
    );

    expect(getClassName(screen.getByTestId('shop-card'))).not.toMatch(PADDING_CLASS_PATTERN);
  });

  it('padding を省略すると md の内側余白が付く', async () => {
    await render(
      <Card testID="shop-card">
        <Text>とんかつ まる兵</Text>
      </Card>,
    );

    expect(getClassName(screen.getByTestId('shop-card'))).toMatch(PADDING_CLASS_PATTERN);
    expect(getClassName(screen.getByTestId('shop-card'))).toContain('p-md');
  });

  it('padding="sm" のとき sm の内側余白が付く', async () => {
    await render(
      <Card padding="sm" testID="shop-card">
        <Text>とんかつ まる兵</Text>
      </Card>,
    );

    expect(getClassName(screen.getByTestId('shop-card'))).toContain('p-sm');
  });

  it('onPress があるときも padding を反映する', async () => {
    await render(
      <Card onPress={jest.fn()} padding="none" testID="shop-card">
        <Text>とんかつ まる兵</Text>
      </Card>,
    );

    expect(getClassName(screen.getByTestId('shop-card'))).not.toMatch(PADDING_CLASS_PATTERN);
  });

  it('testID を渡すと押せないカードにも付与される', async () => {
    await render(
      <Card testID="shop-card">
        <Text>とんかつ まる兵</Text>
      </Card>,
    );

    expect(screen.getByTestId('shop-card')).toBeOnTheScreen();
  });
});

/**
 * 任意の onPress をそのまま転送できることの型レベル回帰テスト。
 * exactOptionalPropertyTypes 下では `onPress?: () => void` と書くと undefined を渡せず、
 * 呼び出し側が条件付きスプレッドを強いられる。実行時ではなく tsc が検知する。
 */
interface OptionalPressConsumer {
  onPress?: (() => void) | undefined;
}

export function ForwardsOptionalPress({ onPress }: OptionalPressConsumer) {
  return <Card onPress={onPress}>{null}</Card>;
}
