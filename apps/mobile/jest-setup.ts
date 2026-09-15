// RNTL 14 は import した時点で expect を拡張する（extend-expect サブパスは 13 で廃止された）
import '@testing-library/react-native';

// react-native-reanimated はテスト環境でネイティブモジュールを持たないためモックする。
// jest.mock のファクトリはファイル先頭に巻き上げられるため import 文の値を参照できず、
// require で遅延読み込みするしかない（Jest の仕様上の制約）
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
