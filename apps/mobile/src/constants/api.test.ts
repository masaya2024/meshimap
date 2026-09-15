/** テスト内で EXPO_PUBLIC_API_URL に差し込む値。既定値と必ず異なるものにする */
const OVERRIDE_API_URL = 'https://api.example.test';

/** constants/api.ts の DEFAULT_API_BASE_URL と対になる期待値（wrangler dev の既定ポート） */
const EXPECTED_DEFAULT_API_BASE_URL = 'http://localhost:8787';

/**
 * API_BASE_URL は import 時に確定するので、毎回モジュールを読み直して環境変数を反映させる。
 * 動的 import() は Jest の CJS 環境（--experimental-vm-modules なし）で使えないため require で読む。
 */
function loadApiConstants(): typeof import('./api') {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./api');
}

describe('API 接続の定数', () => {
  const originalApiUrl = process.env.EXPO_PUBLIC_API_URL;

  afterEach(() => {
    // 他のテストへ環境変数を漏らさないため、必ず元の状態へ戻す
    if (originalApiUrl === undefined) {
      delete process.env.EXPO_PUBLIC_API_URL;
    } else {
      process.env.EXPO_PUBLIC_API_URL = originalApiUrl;
    }
    jest.resetModules();
  });

  it('EXPO_PUBLIC_API_URL が設定されていればその値を使う', () => {
    process.env.EXPO_PUBLIC_API_URL = OVERRIDE_API_URL;

    const { API_BASE_URL } = loadApiConstants();

    expect(API_BASE_URL).toBe(OVERRIDE_API_URL);
  });

  it('EXPO_PUBLIC_API_URL が未設定なら開発用の既定 URL にフォールバックする', () => {
    delete process.env.EXPO_PUBLIC_API_URL;

    const { API_BASE_URL } = loadApiConstants();

    expect(API_BASE_URL).toBe(EXPECTED_DEFAULT_API_BASE_URL);
  });

  it('ネットワーク待ちの上限は正の値で、単位がミリ秒だと名前から分かる', () => {
    const { API_TIMEOUT_MS } = loadApiConstants();

    expect(API_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
