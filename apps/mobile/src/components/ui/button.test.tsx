import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { Button } from './button';

// RNTL 14 の render / fireEvent は async。await を忘れると screen が空のままになる
describe('Button', () => {
  it('ラベルを表示する', async () => {
    await render(<Button label="予約する" onPress={jest.fn()} />);

    expect(screen.getByText('予約する')).toBeOnTheScreen();
  });

  it('押すと onPress が呼ばれる', async () => {
    const onPress = jest.fn();
    await render(<Button label="予約する" onPress={onPress} />);

    await fireEvent.press(screen.getByRole('button'));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('isDisabled のとき onPress を呼ばない', async () => {
    const onPress = jest.fn();
    await render(<Button label="予約する" onPress={onPress} isDisabled />);

    await fireEvent.press(screen.getByRole('button'));

    expect(onPress).not.toHaveBeenCalled();
  });

  it('isLoading のとき onPress を呼ばない', async () => {
    const onPress = jest.fn();
    await render(<Button label="予約する" onPress={onPress} isLoading />);

    await fireEvent.press(screen.getByRole('button'));

    expect(onPress).not.toHaveBeenCalled();
  });

  it('isLoading のときインジケータを表示する', async () => {
    await render(<Button label="予約する" onPress={jest.fn()} isLoading testID="reserve-button" />);

    expect(screen.getByTestId('reserve-button-indicator')).toBeOnTheScreen();
  });

  it('isLoading でないときインジケータを表示しない', async () => {
    await render(<Button label="予約する" onPress={jest.fn()} testID="reserve-button" />);

    expect(screen.queryByTestId('reserve-button-indicator')).toBeNull();
  });

  it('isDisabled をアクセシビリティ状態に反映する', async () => {
    await render(<Button label="予約する" onPress={jest.fn()} isDisabled />);

    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('leadingIcon を渡すと表示する', async () => {
    await render(
      <Button label="予約する" onPress={jest.fn()} leadingIcon={<Text>アイコン</Text>} />,
    );

    expect(screen.getByText('アイコン')).toBeOnTheScreen();
  });

  it('isLoading のとき leadingIcon の代わりにインジケータを表示する', async () => {
    await render(
      <Button
        label="予約する"
        onPress={jest.fn()}
        isLoading
        leadingIcon={<Text>アイコン</Text>}
        testID="reserve-button"
      />,
    );

    expect(screen.queryByText('アイコン')).toBeNull();
    expect(screen.getByTestId('reserve-button-indicator')).toBeOnTheScreen();
  });
});
