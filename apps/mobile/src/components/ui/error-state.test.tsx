import { fireEvent, render, screen } from '@testing-library/react-native';

import { ErrorState } from './error-state';

// RNTL 14 の render / fireEvent は async。await を忘れると screen が空のままになる
describe('ErrorState', () => {
  it('既定のタイトルを表示する', async () => {
    await render(<ErrorState onRetry={jest.fn()} />);

    expect(screen.getByText('エラーが発生しました')).toBeOnTheScreen();
  });

  it('title を渡すと既定のタイトルの代わりに表示する', async () => {
    await render(<ErrorState title="通信に失敗しました" onRetry={jest.fn()} />);

    expect(screen.getByText('通信に失敗しました')).toBeOnTheScreen();
    expect(screen.queryByText('エラーが発生しました')).toBeNull();
  });

  it('description があれば表示する', async () => {
    await render(
      <ErrorState description="電波の良い場所で再度お試しください" onRetry={jest.fn()} />,
    );

    expect(screen.getByText('電波の良い場所で再度お試しください')).toBeOnTheScreen();
  });

  it('description がなければ表示しない', async () => {
    await render(<ErrorState onRetry={jest.fn()} />);

    expect(screen.queryByText('電波の良い場所で再度お試しください')).toBeNull();
  });

  it('「再試行」ボタンを表示する', async () => {
    await render(<ErrorState onRetry={jest.fn()} />);

    expect(screen.getByText('再試行')).toBeOnTheScreen();
  });

  it('「再試行」ボタン押下で onRetry が呼ばれる', async () => {
    const onRetry = jest.fn();
    await render(<ErrorState onRetry={onRetry} />);

    await fireEvent.press(screen.getByRole('button'));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // Icon は装飾としてスクリーンリーダーから隠れているため、RNTL の既定では検索対象外になる
  it('警告アイコンを表示する', async () => {
    await render(<ErrorState onRetry={jest.fn()} testID="shop-error" />);

    expect(
      screen.getByTestId('shop-error-icon', { includeHiddenElements: true }),
    ).toBeOnTheScreen();
  });

  it('testID を指定すると再試行ボタンにも派生した testID が付く', async () => {
    await render(<ErrorState onRetry={jest.fn()} testID="shop-error" />);

    expect(screen.getByTestId('shop-error')).toBeOnTheScreen();
    expect(screen.getByTestId('shop-error-retry-button')).toBeOnTheScreen();
  });
});
