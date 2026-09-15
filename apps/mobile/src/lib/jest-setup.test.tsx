import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

describe('Jest 環境', () => {
  // RNTL 14 の render / fireEvent / renderHook は async。await を忘れると screen が空のままになる
  it('React Native コンポーネントをレンダリングできる', async () => {
    await render(<Text>メシマップ</Text>);

    expect(screen.getByText('メシマップ')).toBeOnTheScreen();
  });

  it('NativeWind の className を付けてもレンダリングできる', async () => {
    await render(<Text className="text-primary-500">メシマップ</Text>);

    expect(screen.getByText('メシマップ')).toBeOnTheScreen();
  });
});
