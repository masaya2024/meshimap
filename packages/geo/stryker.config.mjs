import { createStrykerConfig } from '../../stryker.base.mjs';

// 設定の根拠はすべて ../../stryker.base.mjs にある
export default createStrykerConfig({
  // src/index.ts は再エクスポートだけなので変異を入れても意味が無い
  mutate: ['src/**/*.ts', '!src/**/*.test.ts', '!src/index.ts'],
});
