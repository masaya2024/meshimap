import { fireEvent, render, screen } from '@testing-library/react-native';

import { Input } from './input';

const INPUT_TEST_ID = 'shop-name-input';

/** 枠線色のクラスだけを抜き出す。`border-red-500` のような色つき border ユーティリティに当てる */
const BORDER_COLOR_CLASS_PATTERN = /(^|\s)(border-[a-z]+-\d+)/;

/**
 * NativeWind はテスト環境では className を style に変換しないため、
 * 付与されたユーティリティクラスは props からそのまま読める。
 */
function getClassName(element: ReturnType<typeof screen.getByTestId>): string {
  const { className } = element.props;
  return typeof className === 'string' ? className : '';
}

function getBorderColorClass(testID: string): string {
  const matched = BORDER_COLOR_CLASS_PATTERN.exec(getClassName(screen.getByTestId(testID)));
  return matched?.[2] ?? '';
}

// RNTL 14 の render / fireEvent は async。await を忘れると screen が空のままになる
describe('Input', () => {
  it('ラベルを表示する', async () => {
    await render(<Input label="店名" value="" onChangeText={jest.fn()} />);

    expect(screen.getByText('店名')).toBeOnTheScreen();
  });

  it('入力すると onChangeText が入力値付きで呼ばれる', async () => {
    const onChangeText = jest.fn();
    await render(
      <Input label="店名" value="" onChangeText={onChangeText} testID={INPUT_TEST_ID} />,
    );

    await fireEvent.changeText(screen.getByTestId(INPUT_TEST_ID), 'とんかつ まる兵');

    expect(onChangeText).toHaveBeenCalledTimes(1);
    expect(onChangeText).toHaveBeenCalledWith('とんかつ まる兵');
  });

  it('placeholder を渡すと TextInput に反映される', async () => {
    await render(
      <Input label="店名" value="" onChangeText={jest.fn()} placeholder="例）とんかつ まる兵" />,
    );

    expect(screen.getByPlaceholderText('例）とんかつ まる兵')).toBeOnTheScreen();
  });

  it('isMultiline のとき複数行入力になる', async () => {
    await render(
      <Input label="紹介文" value="" onChangeText={jest.fn()} isMultiline testID={INPUT_TEST_ID} />,
    );

    expect(screen.getByTestId(INPUT_TEST_ID)).toHaveProp('multiline', true);
  });

  it('errorMessage があるときメッセージを表示する', async () => {
    await render(
      <Input
        label="店名"
        value=""
        onChangeText={jest.fn()}
        errorMessage="店名を入力してください"
      />,
    );

    expect(screen.getByText('店名を入力してください')).toBeOnTheScreen();
  });

  it('errorMessage がないときメッセージを表示しない', async () => {
    await render(<Input label="店名" value="" onChangeText={jest.fn()} />);

    expect(screen.queryByText('店名を入力してください')).toBeNull();
  });

  it('errorMessage があるとき枠線が danger 色になる', async () => {
    await render(
      <Input
        label="店名"
        value=""
        onChangeText={jest.fn()}
        errorMessage="店名を入力してください"
        testID={INPUT_TEST_ID}
      />,
    );

    expect(getBorderColorClass(INPUT_TEST_ID)).toBe('border-red-500');
  });

  it('errorMessage がないとき枠線は通常色のままになる', async () => {
    await render(<Input label="店名" value="" onChangeText={jest.fn()} testID={INPUT_TEST_ID} />);

    expect(getBorderColorClass(INPUT_TEST_ID)).toBe('border-neutral-300');
  });

  it('isRequired のとき必須マークを表示する', async () => {
    await render(<Input label="店名" value="" onChangeText={jest.fn()} isRequired />);

    expect(screen.getByText('必須')).toBeOnTheScreen();
  });

  it('isRequired でないとき必須マークを表示しない', async () => {
    await render(<Input label="店名" value="" onChangeText={jest.fn()} />);

    expect(screen.queryByText('必須')).toBeNull();
  });

  it('maxLength を指定すると文字数カウンタを表示する', async () => {
    await render(
      <Input label="紹介文" value="とんかつ" onChangeText={jest.fn()} maxLength={140} />,
    );

    expect(screen.getByText('4/140')).toBeOnTheScreen();
  });

  it('入力が空でもカウンタは 0 を表示する', async () => {
    await render(<Input label="紹介文" value="" onChangeText={jest.fn()} maxLength={140} />);

    expect(screen.getByText('0/140')).toBeOnTheScreen();
  });

  it('上限ちょうどの入力でもカウンタを表示する', async () => {
    await render(<Input label="紹介文" value="とんかつ" onChangeText={jest.fn()} maxLength={4} />);

    expect(screen.getByText('4/4')).toBeOnTheScreen();
  });

  it('maxLength がないとき文字数カウンタを表示しない', async () => {
    await render(<Input label="紹介文" value="とんかつ" onChangeText={jest.fn()} />);

    expect(screen.queryByText(/^\d+\/\d+$/)).toBeNull();
  });

  /**
   * React Native の AccessibilityProps には Web の aria-invalid / accessibilityInvalid が存在しない
   * （node_modules/react-native/Libraries/Components/View/ViewAccessibility.d.ts）。
   * 代わりにエラー内容をアクセシビリティラベルへ載せ、メッセージ自体を alert ロールで公開する。
   */
  it('エラー時はアクセシビリティラベルにエラー内容を含める', async () => {
    await render(
      <Input
        label="店名"
        value=""
        onChangeText={jest.fn()}
        isRequired
        errorMessage="店名を入力してください"
        testID={INPUT_TEST_ID}
      />,
    );

    expect(screen.getByTestId(INPUT_TEST_ID)).toHaveProp(
      'accessibilityLabel',
      '店名、必須、エラー: 店名を入力してください',
    );
  });

  it('エラーでないときはアクセシビリティラベルにエラー文言を含めない', async () => {
    await render(
      <Input label="店名" value="" onChangeText={jest.fn()} isRequired testID={INPUT_TEST_ID} />,
    );

    expect(screen.getByTestId(INPUT_TEST_ID)).toHaveProp('accessibilityLabel', '店名、必須');
  });

  it('エラーメッセージを alert ロールで公開する', async () => {
    await render(
      <Input
        label="店名"
        value=""
        onChangeText={jest.fn()}
        errorMessage="店名を入力してください"
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('店名を入力してください');
  });
});
