import { defineConfig } from 'drizzle-kit';

// D1 は SQLite。マイグレーション SQL は wrangler d1 migrations apply で適用する。
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
  driver: 'd1-http',
});
