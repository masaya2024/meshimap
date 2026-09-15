import { render, screen } from '@testing-library/react-native';
import type { LucideProps } from 'lucide-react-native';
import { MapPin } from 'lucide-react-native';
import { forwardRef } from 'react';
import { Text } from 'react-native';

import { COLORS } from '@/constants/theme';

import { Icon } from './icon';

/**
 * Icon は装飾なのでスクリーンリーダーから隠しており、RNTL 14 の既定
 * （defaultIncludeHiddenElements: false）では隠れた要素が検索対象から外れる。
 * ラッパを取得するクエリでは毎回このオプションが要るため定数にしておく。
 */
const INCLUDE_HIDDEN_ELEMENTS = { includeHiddenElements: true };

/**
 * サイズや色は lucide コンポーネントへ渡す props でしか観測できない。
 * LucideIcon は forwardRef コンポーネントの型なので、ダミーも forwardRef で作って props を記録する。
 */
function createDummyIcon(recordProps: (props: LucideProps) => void) {
  return forwardRef<never, LucideProps>(function DummyIcon(props, _ref) {
    recordProps(props);
    return <Text>ダミーアイコン</Text>;
  });
}

// RNTL 14 の render は async。await を忘れると screen が空のままになる
describe('Icon', () => {
  it('渡したアイコンをレンダリングする', async () => {
    const DummyIcon = createDummyIcon(jest.fn());

    await render(<Icon icon={DummyIcon} />);

    expect(screen.getByText('ダミーアイコン', INCLUDE_HIDDEN_ELEMENTS)).toBeOnTheScreen();
  });

  it('size 未指定のとき 20px が渡る', async () => {
    const recordProps = jest.fn();
    const DummyIcon = createDummyIcon(recordProps);

    await render(<Icon icon={DummyIcon} />);

    expect(recordProps).toHaveBeenCalledWith(expect.objectContaining({ size: 20 }));
  });

  it('size="sm" のとき 16px が渡る', async () => {
    const recordProps = jest.fn();
    const DummyIcon = createDummyIcon(recordProps);

    await render(<Icon icon={DummyIcon} size="sm" />);

    expect(recordProps).toHaveBeenCalledWith(expect.objectContaining({ size: 16 }));
  });

  it('size="lg" のとき 24px が渡る', async () => {
    const recordProps = jest.fn();
    const DummyIcon = createDummyIcon(recordProps);

    await render(<Icon icon={DummyIcon} size="lg" />);

    expect(recordProps).toHaveBeenCalledWith(expect.objectContaining({ size: 24 }));
  });

  it('color 未指定のとき neutral-700 が渡る', async () => {
    const recordProps = jest.fn();
    const DummyIcon = createDummyIcon(recordProps);

    await render(<Icon icon={DummyIcon} />);

    expect(recordProps).toHaveBeenCalledWith(
      expect.objectContaining({ color: COLORS.neutral[700] }),
    );
  });

  it('color を指定するとその色が渡る', async () => {
    const recordProps = jest.fn();
    const DummyIcon = createDummyIcon(recordProps);

    await render(<Icon icon={DummyIcon} color={COLORS.primary[500]} />);

    expect(recordProps).toHaveBeenCalledWith(
      expect.objectContaining({ color: COLORS.primary[500] }),
    );
  });

  // 不具合の再発防止: lucide は testID を data-testid に変換してしまうため、
  // 実物のアイコンで getByTestId が通ることを確認する（ダミーでは検証にならない）
  it('実物の lucide アイコンに testID を渡すと getByTestId で取得できる', async () => {
    await render(<Icon icon={MapPin} testID="map-pin-icon" />);

    expect(screen.getByTestId('map-pin-icon', INCLUDE_HIDDEN_ELEMENTS)).toBeOnTheScreen();
  });

  it('testID は lucide コンポーネントには渡さない', async () => {
    const recordProps = jest.fn();
    const DummyIcon = createDummyIcon(recordProps);

    await render(<Icon icon={DummyIcon} testID="star-icon" />);

    expect(recordProps).toHaveBeenCalledWith(expect.not.objectContaining({ testID: 'star-icon' }));
  });

  it('testID 未指定のときはラッパに testID が付かない', async () => {
    await render(<Icon icon={MapPin} />);

    expect(screen.queryByTestId('map-pin-icon', INCLUDE_HIDDEN_ELEMENTS)).toBeNull();
  });

  // 装飾アイコンなので、iOS / Android どちらのスクリーンリーダーからも隠れている必要がある
  it('スクリーンリーダーから隠す指定を iOS / Android 両方に付ける', async () => {
    await render(<Icon icon={MapPin} testID="map-pin-icon" />);

    const wrapper = screen.getByTestId('map-pin-icon', INCLUDE_HIDDEN_ELEMENTS);

    expect(wrapper.props.accessibilityElementsHidden).toBe(true);
    expect(wrapper.props.importantForAccessibility).toBe('no-hide-descendants');
  });

  // ラッパ View を挟んだことでレイアウトが変わっていないことの回帰テスト
  it('ラッパのサイズがアイコンの実寸と一致する', async () => {
    await render(<Icon icon={MapPin} size="lg" testID="map-pin-icon" />);

    expect(screen.getByTestId('map-pin-icon', INCLUDE_HIDDEN_ELEMENTS)).toHaveStyle({
      width: 24,
      height: 24,
    });
  });
});
