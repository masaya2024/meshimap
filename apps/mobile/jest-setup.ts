// RNTL 14 は import した時点で expect を拡張する（extend-expect サブパスは 13 で廃止された）
import '@testing-library/react-native';

// react-native-reanimated はテスト環境でネイティブモジュールを持たないためモックする
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
