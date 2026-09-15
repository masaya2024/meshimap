import { render, screen } from '@testing-library/react-native';

import { RADIUS } from '@/constants/theme';

import { Skeleton } from './skeleton';

// RNTL 14 の render は async。await を忘れると screen が空のままになる
describe('Skeleton', () => {
  it('指定した高さが反映される', async () => {
    await render(<Skeleton height={24} testID="skeleton" />);

    expect(screen.getByTestId('skeleton')).toHaveStyle({ height: 24 });
  });

  it('幅を省略すると親の幅いっぱいになる', async () => {
    await render(<Skeleton height={24} testID="skeleton" />);

    expect(screen.getByTestId('skeleton')).toHaveStyle({ width: '100%' });
  });

  it('数値の幅を指定するとそのまま反映される', async () => {
    await render(<Skeleton height={24} width={120} testID="skeleton" />);

    expect(screen.getByTestId('skeleton')).toHaveStyle({ width: 120 });
  });

  it('パーセント指定の幅を受け付ける', async () => {
    await render(<Skeleton height={24} width="50%" testID="skeleton" />);

    expect(screen.getByTestId('skeleton')).toHaveStyle({ width: '50%' });
  });

  it('既定の shape は rect で角丸がカード内の小要素向けの値になる', async () => {
    await render(<Skeleton height={24} testID="skeleton" />);

    expect(screen.getByTestId('skeleton')).toHaveStyle({ borderRadius: RADIUS.md });
  });

  it('shape="circle" のとき角丸が pill になる', async () => {
    await render(<Skeleton height={40} shape="circle" testID="skeleton" />);

    expect(screen.getByTestId('skeleton')).toHaveStyle({ borderRadius: RADIUS.pill });
  });

  it('shape="circle" で幅を省略すると高さと同じ幅になる', async () => {
    await render(<Skeleton height={40} shape="circle" testID="skeleton" />);

    expect(screen.getByTestId('skeleton')).toHaveStyle({ width: 40 });
  });

  it('shape="text" のとき指定した高さより低い行状になる', async () => {
    const lineBoxHeight = 20;
    await render(<Skeleton height={lineBoxHeight} shape="text" testID="skeleton" />);

    // 行ボックス 20px に対してバーは 70% の 14px。文字の見た目に近づけるため意図的に細くする
    expect(screen.getByTestId('skeleton')).toHaveStyle({ height: 14 });
    expect(screen.getByTestId('skeleton')).toHaveStyle({ borderRadius: RADIUS.sm });
  });
});
