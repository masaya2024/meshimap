/**
 * 開発時の既定 API ベース URL。
 * iOS シミュレータ / Android エミュレータの差異は EXPO_PUBLIC_API_URL で吸収する前提で、
 * ここは wrangler dev の既定ポートに合わせる（apps/api/wrangler.toml と対応）。
 */
const DEFAULT_API_BASE_URL = 'http://localhost:8787';

/**
 * EXPO_PUBLIC_ 接頭辞の環境変数だけがクライアントバンドルに埋め込まれる。
 * 未設定でも開発が止まらないよう既定値にフォールバックする。
 */
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? DEFAULT_API_BASE_URL;

/** ネットワーク待ちの上限。これを超えたらローディングを畳んでエラー表示に切り替える */
export const API_TIMEOUT_MS = 15_000;
