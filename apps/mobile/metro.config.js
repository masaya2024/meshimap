const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

// Expo SDK 52 以降はモノレポを自動検出するため watchFolders / nodeModulesPaths の手動設定は不要
const config = getDefaultConfig(__dirname);

/**
 * テストファイルを Metro の探索対象から外す。
 *
 * expo-router は `src/app/` 配下を require.context で走査し、
 * 除外するのは `+html` / `+api` / `+middleware` だけで、拡張子が .tsx なら残り全部をルートとして拾う
 * （node_modules/expo-router/_ctx.ios.js の正規表現で確認）。
 * そのためテストを画面と共置きすると本番バンドルに @testing-library/react-native ごと混入し、
 * それが Node 組み込みの `console` を require するため `expo export` がバンドルエラーで落ちる。
 *
 * Expo の既定 blockList も同じ理由で `/__tests__/` を除外している。
 * ここではディレクトリではなくファイル名の規約（*.test.* / *.spec.*）で守り、
 * 「テストは実装の隣に置く」というリポジトリ全体の方針を app/ 配下でも崩さずに済ませる。
 * Jest は Metro を経由しないのでテストの実行には影響しない。
 */
const TEST_FILE_PATTERN = /\.(test|spec)\.[jt]sx?$/;

config.resolver.blockList = [...config.resolver.blockList, TEST_FILE_PATTERN];

module.exports = withNativeWind(config, { input: './src/global.css' });
