import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  // schema/index.ts が全テーブルを再エクスポートしているため、ここ 1 つを指せば全部拾える。
  // ワイルドカード './src/db/schema/*.ts' でも動くが、index.ts 経由にすると
  // 「index に書き忘れたテーブルはマイグレーションにも出ない」という形で漏れに気づける。
  schema: './src/db/schema/index.ts',
  out: './migrations',
  dialect: 'sqlite',
  // D1 に対しては 'd1-http' を指定する。generate は資格情報なしで通る（push には必要）。
  driver: 'd1-http',
});
