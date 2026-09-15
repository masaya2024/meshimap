import { render, screen } from '@testing-library/react-native';

import CatalogScreen from './catalog';

/** 画面に必ず並ぶセクション見出し。プリミティブを足したらここにも足す */
const EXPECTED_SECTION_TITLES = [
  'Button',
  'Badge',
  'Card',
  'Input',
  'Skeleton',
  'Icon',
  'EmptyState',
  'ErrorState',
];

describe('CatalogScreen', () => {
  it('全プリミティブのセクションが例外なく描画される', async () => {
    await render(<CatalogScreen />);

    for (const title of EXPECTED_SECTION_TITLES) {
      expect(screen.getByText(title)).toBeTruthy();
    }
  });
});
