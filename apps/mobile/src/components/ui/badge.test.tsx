import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import type { BadgeTone } from './badge';
import { Badge } from './badge';

/** 背景色のクラスだけを抜き出す。`bg-green-50` などの背景ユーティリティにだけ当てる */
const BACKGROUND_CLASS_PATTERN = /(^|\s)(bg-\S+)/;

/** 網羅漏れを型で検出するため、Record のキーとして全 tone を列挙する */
const ALL_TONES = Object.keys({
  neutral: true,
  success: true,
  warning: true,
  danger: true,
  brand: true,
} satisfies Record<BadgeTone, true>) as BadgeTone[];

/**
 * NativeWind はテスト環境では className を style に変換しないため、
 * 付与されたユーティリティクラスは props からそのまま読める。
 */
function getClassName(element: ReturnType<typeof screen.getByTestId>): string {
  const { className } = element.props;
  return typeof className === 'string' ? className : '';
}

function getBackgroundClass(testID: string): string {
  const matched = BACKGROUND_CLASS_PATTERN.exec(getClassName(screen.getByTestId(testID)));
  return matched?.[2] ?? '';
}

// RNTL 14 の render / fireEvent は async。await を忘れると screen が空のままになる
describe('Badge', () => {
  it('ラベルを表示する', async () => {
    await render(<Badge label="営業中" />);

    expect(screen.getByText('営業中')).toBeOnTheScreen();
  });

  it('tone ごとに異なる背景クラスが付く（5 種すべて）', async () => {
    await render(
      <>
        {ALL_TONES.map((tone) => (
          <Badge key={tone} label="営業中" tone={tone} testID={`badge-${tone}`} />
        ))}
      </>,
    );

    const backgroundClasses = ALL_TONES.map((tone) => getBackgroundClass(`badge-${tone}`));

    // 5 種すべてに背景クラスが付き、かつ互いに重複しないこと
    expect(backgroundClasses.every((className) => className !== '')).toBe(true);
    expect(new Set(backgroundClasses).size).toBe(ALL_TONES.length);
  });

  it('tone を省略すると neutral と同じ背景クラスになる', async () => {
    await render(
      <>
        <Badge label="定休日" testID="badge-default" />
        <Badge label="定休日" tone="neutral" testID="badge-neutral" />
      </>,
    );

    expect(getBackgroundClass('badge-default')).toBe(getBackgroundClass('badge-neutral'));
  });

  it('leadingIcon を渡すと表示される', async () => {
    await render(<Badge label="営業中" leadingIcon={<Text>🕒</Text>} testID="open-badge" />);

    expect(screen.getByTestId('open-badge-leading-icon')).toBeOnTheScreen();
    expect(screen.getByText('🕒')).toBeOnTheScreen();
  });

  it('leadingIcon を渡さないとアイコン枠を描画しない', async () => {
    await render(<Badge label="営業中" testID="open-badge" />);

    expect(screen.queryByTestId('open-badge-leading-icon')).toBeNull();
  });
});
