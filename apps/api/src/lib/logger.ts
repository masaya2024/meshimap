/**
 * Worker 上の唯一のログ出口。
 * 規約で console の直接呼び出しを禁じているため、ここだけが console を触る。
 * wrangler.jsonc の observability が有効なので、この出力は Cloudflare のログに乗る。
 */
export function logError(message: string, cause: unknown): void {
  // eslint-disable-next-line no-console -- ロガー実装本体。ここ以外では console を呼ばない
  console.error(message, cause);
}
