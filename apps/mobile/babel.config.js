/** NativeWind のプリセットが無条件で追加する Reanimated（Reanimated 4 では Worklets）プラグイン */
const REANIMATED_BABEL_PLUGIN = 'react-native-reanimated/plugin';

/**
 * Jest 用に NativeWind プリセットから Reanimated プラグインだけを取り除く。
 *
 * react-native-worklets の Babel プラグインは内部で自前に require('@babel/core') するが、
 * npm が babel-jest@30 の peerDependency を満たすためルートへ巻き上げた @babel/core@8 を掴み、
 * Babel 7 専用の @babel/preset-typescript を読めずに変換が落ちる。
 * テストでは react-native-reanimated 自体をモックしており worklet 化は不要なので外す。
 * ルートの @babel/core が 7 系に固定されたら、この回避と下の worklets/reanimated 無効化は削除してよい。
 */
function createNativeWindPresetWithoutReanimated() {
  const nativeWindPreset = require('nativewind/babel');

  return (...presetArgs) => {
    const preset = nativeWindPreset(...presetArgs);
    return {
      ...preset,
      plugins: preset.plugins.filter((plugin) => plugin !== REANIMATED_BABEL_PLUGIN),
    };
  };
}

module.exports = function (api) {
  // NODE_ENV で構成を切り替えるため、キャッシュキーに NODE_ENV を含める
  api.cache.using(() => process.env.NODE_ENV);

  const isTestEnvironment = process.env.NODE_ENV === 'test';

  // NativeWind は babel / metro / tailwind の 3 箇所が揃わないと無言で効かない。
  // jsxImportSource の指定と nativewind/babel プリセットの両方が必須。
  const expoPresetOptions = { jsxImportSource: 'nativewind' };
  if (isTestEnvironment) {
    expoPresetOptions.worklets = false;
    expoPresetOptions.reanimated = false;
  }

  return {
    presets: [
      ['babel-preset-expo', expoPresetOptions],
      isTestEnvironment ? createNativeWindPresetWithoutReanimated() : 'nativewind/babel',
    ],
  };
};
