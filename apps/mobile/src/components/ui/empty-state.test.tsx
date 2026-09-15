import { fireEvent, render, screen } from '@testing-library/react-native';
import type { LucideProps } from 'lucide-react-native';
import { forwardRef } from 'react';
import { Text } from 'react-native';

import { EmptyState } from './empty-state';

/**
 * 実物の lucide アイコンは SVG を描画して検証しにくいため、テキストを返すダミーを使う。
 * LucideIcon は forwardRef コンポーネントの型なので、ダミーも forwardRef で作る。
 */
const DummyIcon = forwardRef<never, LucideProps>(function DummyIcon() {
  return <Text>ダミーアイコン</Text>;
});

// RNTL 14 の render / fireEvent は async。await を忘れると screen が空のままになる
describe('EmptyState', () => {
  it('タイトルを表示する', async () => {
    await render(<EmptyState icon={DummyIcon} title="お店が見つかりませんでした" />);

    expect(screen.getByText('お店が見つかりませんでした')).toBeOnTheScreen();
  });

  it('渡したアイコンを表示する', async () => {
    await render(<EmptyState icon={DummyIcon} title="お店が見つかりませんでした" />);

    expect(screen.getByText('ダミーアイコン')).toBeOnTheScreen();
  });

  it('description があれば表示する', async () => {
    await render(
      <EmptyState
        icon={DummyIcon}
        title="お店が見つかりませんでした"
        description="条件を変えて探してみてください"
      />,
    );

    expect(screen.getByText('条件を変えて探してみてください')).toBeOnTheScreen();
  });

  it('description がなければ表示しない', async () => {
    await render(<EmptyState icon={DummyIcon} title="お店が見つかりませんでした" />);

    expect(screen.queryByText('条件を変えて探してみてください')).toBeNull();
  });

  it('action があればボタンを表示する', async () => {
    await render(
      <EmptyState
        icon={DummyIcon}
        title="お店が見つかりませんでした"
        action={{ label: '条件をリセット', onPress: jest.fn() }}
      />,
    );

    expect(screen.getByRole('button')).toBeOnTheScreen();
    expect(screen.getByText('条件をリセット')).toBeOnTheScreen();
  });

  it('action のボタンを押すと onPress が呼ばれる', async () => {
    const onPress = jest.fn();
    await render(
      <EmptyState
        icon={DummyIcon}
        title="お店が見つかりませんでした"
        action={{ label: '条件をリセット', onPress }}
      />,
    );

    await fireEvent.press(screen.getByRole('button'));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('action がなければボタンを表示しない', async () => {
    await render(<EmptyState icon={DummyIcon} title="お店が見つかりませんでした" />);

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('testID を指定するとアクションボタンにも派生した testID が付く', async () => {
    await render(
      <EmptyState
        icon={DummyIcon}
        title="お店が見つかりませんでした"
        action={{ label: '条件をリセット', onPress: jest.fn() }}
        testID="shop-empty"
      />,
    );

    expect(screen.getByTestId('shop-empty')).toBeOnTheScreen();
    expect(screen.getByTestId('shop-empty-action-button')).toBeOnTheScreen();
  });

  // ここから下は Button プリミティブへの置き換えで初めて扱えるようになった振る舞い
  it('action.isDisabled が true のときは押しても onPress を呼ばない', async () => {
    const onPress = jest.fn();
    await render(
      <EmptyState
        icon={DummyIcon}
        title="お店が見つかりませんでした"
        action={{ label: '条件をリセット', onPress, isDisabled: true }}
      />,
    );

    await fireEvent.press(screen.getByRole('button'));

    expect(onPress).not.toHaveBeenCalled();
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('action.isLoading が true のときは onPress を呼ばずインジケータを表示する', async () => {
    const onPress = jest.fn();
    await render(
      <EmptyState
        icon={DummyIcon}
        title="お店が見つかりませんでした"
        action={{ label: '再読み込み', onPress, isLoading: true }}
        testID="shop-empty"
      />,
    );

    await fireEvent.press(screen.getByRole('button'));

    expect(onPress).not.toHaveBeenCalled();
    expect(screen.getByTestId('shop-empty-action-button-indicator')).toBeOnTheScreen();
  });

  // ここから下はスクリーンリーダー向けの振る舞い
  it('タイトルと説明をひとつの読み上げ単位にまとめる', async () => {
    await render(
      <EmptyState
        icon={DummyIcon}
        title="お店が見つかりませんでした"
        description="条件を変えて探してみてください"
      />,
    );

    expect(
      screen.getByLabelText('お店が見つかりませんでした。条件を変えて探してみてください'),
    ).toBeOnTheScreen();
  });

  it('description がなければタイトルだけを読み上げ単位にする', async () => {
    await render(<EmptyState icon={DummyIcon} title="お店が見つかりませんでした" />);

    expect(screen.getByLabelText('お店が見つかりませんでした')).toBeOnTheScreen();
  });

  it('読み上げ単位を静的テキストとして公開し、出現時に読み上げられるようにする', async () => {
    await render(<EmptyState icon={DummyIcon} title="お店が見つかりませんでした" />);

    const announcedGroup = screen.getByLabelText('お店が見つかりませんでした');

    expect(announcedGroup).toHaveProp('accessibilityRole', 'text');
    expect(announcedGroup).toHaveProp('accessibilityLiveRegion', 'polite');
  });
});
